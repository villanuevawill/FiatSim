// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// When running the script with `npx hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
const { BigNumber } = require("ethers");
const hre = require("hardhat");
const ivault = require("../artifacts/contracts/balancer-core-v2/vault/interfaces/IVault.sol/IVault.json").abi;
const dsMath = require("../helpers/dsmath-ethers");
const fs = require('fs');
const { performance } = require('perf_hooks');

const daiWhaleAddress = "0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503";
const daiAddress = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const daiPTAddress = "0xCCE00da653eB50133455D4075fE8BcA36750492c";
const ptPoolID = "0x8ffd1dc7c3ef65f833cf84dbcd15b6ad7f9c54ec000200000000000000000199";
const balancerVaultAddress = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const fiatActionAddress = "0x0021DCEeb93130059C2BbBa7DacF14fe34aFF23c";
const fiatDaiVaultAddress = "0xb6922A39C85a4E838e1499A8B7465BDca2E49491";
const fiatProxyFactoryAddress = "0x7Ee06e44C4764A49346290CD9a2267DB6daD7214";
const fiatAddress = "0x586Aa273F262909EEF8fA02d90Ab65F5015e0516";
const fiatCurvePoolAddress = "0xDB8Cc7eCeD700A4bfFdE98013760Ff31FF9408D8";

const MAX_APPROVE = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const DECIMALS = 18;
const DAI_PRICE_ETH = 0.0004965;
const ETH_PRICE_DAI = ethers.utils.parseUnits((1/DAI_PRICE_ETH).toString(), DECIMALS);
const CURRENT_TIME = Math.round((new Date()).getTime() / 1000);
const TERM_MATURITY = 1663361092;
const YEAR_SECONDS = 31536000;
const MATURITY_YEAR_FACTOR = (TERM_MATURITY - CURRENT_TIME) / YEAR_SECONDS;
const FIAT_INTEREST_RATE = .01;
const FIAT_PRICE_DAI = 1;

const DAI_BALANCE_START = 10000;
const DAI_BALANCE_INCREMENT = 2000;
const DAI_BALANCE_END = 150000;

async function main() {
  let daiBalance = ethers.utils.parseUnits(Number(DAI_BALANCE_START).toString(), DECIMALS);
  const outputData = [];

  await (async () => {
    // var stream = fs.createWriteStream("fiatsim.json", {flags:'a'});
    for (let i = DAI_BALANCE_START; i <= DAI_BALANCE_END; i += DAI_BALANCE_INCREMENT) {
      startTime = performance.now()
      const output = await fiatLeverage(i);
      console.log('Time to run fiatLeverage: ', Math.round(performance.now() - startTime),'ms');
      const serialized = {};

      for (const [key, value] of Object.entries(output)) {
        if (value instanceof BigNumber) {
          serialized[key] = Number(ethers.utils.formatUnits(value, DECIMALS));
        } else {
          serialized[key] = value;
        }
      }

      outputData.push(serialized);
      console.log("output entry: ", serialized);
      writeFile(outputData);
      startTime = performance.now()
      await network.provider.request({ // reset hardhat
        method: "hardhat_reset",
        params: [
          {
            forking: {
              jsonRpcUrl: process.env.ALCHEMY_URL,
              blockNumber: process.env.BLOCK_NUMBER,
            },
          },
        ],
      });
      console.log('Time to reset hardhat: ', Math.round(performance.now() - startTime),'ms');
    } // end for loop across fiatLeverage
  })() // end main
}

function writeFile(data) {
  startTime = performance.now()
  fs.writeFileSync('fiatsim.json', JSON.stringify(data), (err) => {
    if (err) {
      throw err;
    }
    console.log("JSON data is saved.");
  });
  console.log("Time to write file: ", performance.now() - startTime,'ms');
}

async function fiatLeverage(amount) {
  const signer = (await ethers.getSigners())[0];

  const startingDaiBalanceFixed = amount;

  const startingDaiBalance = ethers.utils.parseUnits(Number(startingDaiBalanceFixed).toString(), DECIMALS);
  let daiBalance = startingDaiBalance;

  startTime = performance.now()
  await seedSigner(startingDaiBalance);
  console.log('Time to seed signer: ', Math.round(performance.now() - startTime),'ms');
  let totalDaiEarned = ethers.utils.parseUnits("0");
  let totalDaiBalance = ethers.utils.parseUnits("0");
  let totalInterestPaid = ethers.utils.parseUnits("0");

  let daiEarned = BigNumber.from(0);
  let cycles = 0;

  await (async () => {
    while (daiEarned.gte(BigNumber.from(0))) {
      const receipt = await leverageCycle(daiBalance);

      const {
        gasDai,
        interestDai,
        finalDaiBalance,
      } = receipt;

      daiEarned = receipt.daiEarned;

      if (daiEarned.gte(BigNumber.from(0))) {
        totalDaiEarned = totalDaiEarned.add(daiEarned);
        totalInterestPaid = totalInterestPaid.add(interestDai);
        daiBalance = receipt.daiBalance;
        cycles++;
      }
    } // end while loop across leverageCycle
  })();

  const earnedFixed = Number(ethers.utils.formatUnits(totalDaiEarned, DECIMALS));
  const netAPY = earnedFixed/startingDaiBalanceFixed/MATURITY_YEAR_FACTOR;
  // console.log("Final Net APY: ", netAPY);
  showProfit(startingDaiBalanceFixed, ptBalance, fiatDebtCost, totalInterestPaid, gasDai, totalDaiEarned, netAPY);

  return {
    cycles,
    startingDaiBalance,
    totalDaiEarned,
    totalInterestPaid,
    daiBalance,
    netAPY,
  }
}

async function leverageCycle(amount) {
  const signer = (await ethers.getSigners())[0];

  const startingEth = await signer.getBalance();

  const {ptBalance,leftoverDai} = await purchasePTs(amount);
  const fiatDebt = await collateralizeForFiat();
  const daiBalance = await curveSwapFiatForDai();

  const endingEth = await signer.getBalance();
  const gasDai = dsMath.wmul(startingEth.sub(endingEth), ETH_PRICE_DAI);
  const interestDai = dsMath.wmul(fiatDebt, ethers.utils.parseUnits((MATURITY_YEAR_FACTOR * FIAT_INTEREST_RATE * FIAT_PRICE_DAI).toFixed(DECIMALS).toString(), DECIMALS));
  const fiatDebtCost = dsMath.wmul(fiatDebt, ethers.utils.parseUnits(Number(FIAT_PRICE_DAI).toString()))
  const finalDaiBalance = ptBalance.sub(gasDai).sub(interestDai).add(daiBalance).sub(fiatDebtCost);
  const daiEarned = finalDaiBalance.sub(amount);
  const netAPY = daiEarned/amount/MATURITY_YEAR_FACTOR;

  showProfit(amount, ptBalance, leftoverDai, fiatDebtCost, interestDai, gasDai, daiEarned, netAPY);

  console.log("Final Dai Balance: ", ethers.utils.formatUnits(finalDaiBalance, DECIMALS));
  console.log("Dai Gained: ", ethers.utils.formatUnits(daiEarned, DECIMALS));

  return {
    gasDai,
    interestDai,
    finalDaiBalance,
    daiBalance,
    daiEarned,
  }
}

function showProfit(amount, ptBalance, leftoverDai, fiatDebtCost, interestDai, gasDai, daiEarned, netAPY) {
  console.log('profit calculation:'
    + '\n  - start with Dai  : ' + Math.round(amount / 10 ** 18)
    + '\n  + swap for PTs    : ' + Math.round(ptBalance / 10 ** 18) + ' using ' + Math.round(amount - leftoverDai) + ' Dai'
    + '\n  - borrow FIAT     : ' + Math.round(fiatDebtCost / 10 ** 18)
    + '\n  - pay interest    : ' + Math.round(interestDai / 10 ** 18)
    + '\n  - pay gas         : ' + Math.round(gasDai / 10 ** 18)
    + '\n  = daiEarned       : ' + Math.round(daiEarned / 10 ** 18)
    + '\n  = net APY         : ' + Math.round(netAPY * 100 * 100) / 100 + '%'
  );
}

async function seedSigner(daiAmount) {
  const signer = (await ethers.getSigners())[0];

  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [daiWhaleAddress],
  });

  const daiWhaleSigner = await ethers.getSigner(daiWhaleAddress)

  // Send some ether to the holder so that they can transfer tokens
  await hre.network.provider.send("hardhat_setBalance", [
    daiWhaleAddress,
    ethers.utils.parseEther("10.0").toHexString()
  ]);

  // first zero out balance
  const daiERC20 = await ethers.getContractAt("ERC20", daiAddress, signer);
  const currentBalance = await daiERC20.balanceOf(signer.address);

  if (currentBalance.gt(BigNumber.from(0))) {
    daiERC20.transfer(daiWhaleAddress, currentBalance);
  }

  const daiERC20Whale = await ethers.getContractAt("ERC20", daiAddress, daiWhaleSigner);

  const transaction = await daiERC20Whale.transfer(signer.address, daiAmount);
  const balanceOfSigner = await daiERC20Whale.balanceOf(signer.address);

  console.log("confirmed transferred balance: ", balanceOfSigner);
}

async function purchasePTs(amount) {
  const signer = (await ethers.getSigners())[0];

  const ccPool =  await new ethers.Contract(balancerVaultAddress, ivault, signer);

  const singleSwap = {
    poolId: ptPoolID,
    kind: 0, // GIVEN_IN
    assetIn: daiAddress,
    assetOut: daiPTAddress,
    amount: amount,
    userData: "0x00",
  };

  const funds = {
    sender: signer.address,
    recipient: signer.address,
    fromInternalBalance: false,
    toInternalBalance: false,
  };

  const limit = amount; // For now don't worry about limit since it is a sim
  const deadline = Math.round(Date.now() / 1000) + 100; // 100 seconds expiration

  const daiERC20 = await ethers.getContractAt("ERC20", daiAddress, signer);
  await daiERC20.approve(balancerVaultAddress, MAX_APPROVE);
  const daiBalance = await daiERC20.balanceOf(signer.address);

  await ccPool.swap(singleSwap, funds, limit, deadline);

  const ptERC20 = await ethers.getContractAt("ERC20", daiPTAddress, signer);
  const ptBalance = await ptERC20.balanceOf(signer.address);

  console.log("PTs Acquired: ", ethers.utils.formatUnits(ptBalance, DECIMALS)
    + 'for ' + ethers.utils.formatUnits(amount - daiBalance, DECIMALS)
    + ', left over ' + ethers.utils.formatUnits(daiBalance, DECIMALS) + ' Dai'
    );

  return {ptBalance, daiBalance};
}

async function collateralizeForFiat() {
  const signer = (await ethers.getSigners())[0];

  const vault = await ethers.getContractAt("IVaultEPT", fiatDaiVaultAddress, signer);

  // This method of calculating takes into account the accumulator interest
  // this means you can never be liquidated
  const fairPrice = await vault.fairPrice(0, true, false);

  const ptERC20 = await ethers.getContractAt("ERC20", daiPTAddress, signer);
  const ptBalance = await ptERC20.balanceOf(signer.address);
  // Max debt that can be acquired
  const maxDebt = dsMath.wmul(fairPrice, ptBalance);
  console.log("Fair Price: ", ethers.utils.formatUnits(fairPrice, DECIMALS));
  console.log("Max Debt: ", ethers.utils.formatUnits(maxDebt, DECIMALS));

  const fiatActions = await ethers
  .getContractAt("VaultEPTActions", fiatActionAddress, signer);

  const proxyFactory = await ethers.getContractAt("IPRBProxyFactory", fiatProxyFactoryAddress);
  const receipt = await proxyFactory.deployFor(signer.address);
  const receiptData = await receipt.wait();

  const proxyAddress = receiptData.events?.filter(x => x.event == 'DeployProxy')[0].args.proxy;

  const userProxy = await ethers.getContractAt("IPRBProxy", proxyAddress);
  await ptERC20.approve(proxyAddress, MAX_APPROVE);

  const functionData = fiatActions.interface.encodeFunctionData(
    'modifyCollateralAndDebt',
    [
      fiatDaiVaultAddress,
      daiPTAddress,
      0,
      proxyAddress,
      signer.address,
      signer.address,
      ptBalance,
      maxDebt.sub(ethers.utils.parseUnits("20", 18))
    ]
  );

  await userProxy.execute(fiatActionAddress, functionData);

  const fiatERC20 = await ethers.getContractAt("ERC20", fiatAddress, signer);
  const fiatBalance = await fiatERC20.balanceOf(signer.address);

  console.log("Current Fiat Balance: ", ethers.utils.formatUnits(fiatBalance, DECIMALS));

  return fiatBalance;
}

async function curveSwapFiatForDai() {
  const signer = (await ethers.getSigners())[0];

  const fiatERC20 = await ethers.getContractAt("ERC20", fiatAddress, signer);
  const fiatBalance = await fiatERC20.balanceOf(signer.address);
  await fiatERC20.approve(fiatCurvePoolAddress, MAX_APPROVE);
  const curvePool = await ethers.getContractAt("ICurveFi", fiatCurvePoolAddress, signer);
  await curvePool.exchange_underlying(0, 1, fiatBalance, BigNumber.from("0"), signer.address);

  const daiERC20 = await ethers.getContractAt("ERC20", daiAddress, signer);
  const newDaiBalance = await daiERC20.balanceOf(signer.address);
  
  console.log("Swapped and received Dai: ", ethers.utils.formatUnits(newDaiBalance, DECIMALS));

  return newDaiBalance;
}


// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
