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
// This is is just used on maturity for the buyback price
const FIAT_PRICE_DAI = 1;

const FLASH_LOAN_INTEREST = .0009;

const DAI_BALANCE_START = 10000;
const DAI_BALANCE_INCREMENT = 2000;
const DAI_BALANCE_END = 150000;

hre.ethers.provider.on("block", async (blockNumber) => {updateGasPriceIfNecesary("Expected")});

async function updateGasPriceIfNecesary(text) {
  // if (text!=="Expected") text="Unexpected";
  feeDataOld = await hre.ethers.provider.getFeeData()
  if (Number(hre.ethers.utils.formatUnits(feeDataOld.gasPrice,9)) != 30) {
    await network.provider.send("hardhat_setNextBlockBaseFeePerGas",[`0x${Number(29*1e9).toString(16)}`]);
    feeDataNew = await hre.ethers.provider.getFeeData()
    blocknumber = await hre.ethers.provider.getBlockNumber()
    console.log(`${text} new Block ${blocknumber}: gas price from ${hre.ethers.utils.formatUnits(feeDataOld.gasPrice,9)} to ${hre.ethers.utils.formatUnits(feeDataNew.gasPrice,9)}`);
  }
}

async function main() {
  // update to use tasks instead of redundancy
  await simulate();
  await simulate(true);
}

async function simulate(usesFlashLoan) {
  let daiBalance = ethers.utils.parseUnits(Number(DAI_BALANCE_START).toString(), DECIMALS);
  const outputData = [];

  await (async () => {
    for (let i = DAI_BALANCE_START; i <= DAI_BALANCE_END; i += DAI_BALANCE_INCREMENT) {
      const output = await fiatLeverage(i, usesFlashLoan);
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

      await hre.network.provider.request({
        method: "hardhat_reset",
        params: [
          {
            forking: {
              jsonRpcUrl: process.env.ALCHEMY_URL,
              blockNumber: Number(process.env.BLOCK_NUMBER),
            },
          },
        ],
      });
    }
  })()

  console.log(outputData);
  const data = JSON.stringify(outputData);

  fs.writeFile(usesFlashLoan ? 'fiatsim.json' : "fiatsim_flashloan.json", data, (err) => {
    if (err) {
        throw err;
    }
    console.log("JSON data is saved.");
  });
}

async function fiatLeverage(amount, usesFlashLoan) {
  const signer = (await ethers.getSigners())[0];

  const startingDaiBalanceFixed = amount;

  const startingDaiBalance = ethers.utils.parseUnits(Number(startingDaiBalanceFixed).toString(), DECIMALS);
  let daiBalance = startingDaiBalance;

  await seedSigner(startingDaiBalance);
  let totalDaiEarned = ethers.utils.parseUnits("0");
  let totalDaiBalance = ethers.utils.parseUnits("0");
  let totalInterestPaid = ethers.utils.parseUnits("0");
  let gasDai = ethers.utils.parseUnits("0");
  let totalPTsCollateralized = ethers.utils.parseUnits("0");
  let totalDaiUsedToPurchasePTs = ethers.utils.parseUnits("0");

  let daiEarned = BigNumber.from(0);
  let cycles = 0;

  await (async () => {
    while (daiEarned.gte(BigNumber.from(0))) {
      const receipt = await leverageCycle(daiBalance, usesFlashLoan && cycles > 0);

      const {
        interestDai,
        daiBalanceOnMaturity,
        ptBalance,
      } = receipt;

      daiEarned = receipt.daiEarned;

      if (daiEarned.gte(BigNumber.from(0))) {
        totalDaiUsedToPurchasePTs = totalDaiUsedToPurchasePTs.add(ethers.utils.parseUnits(amount.toString(), DECIMALS));
        totalDaiEarned = totalDaiEarned.add(daiEarned);
        totalInterestPaid = totalInterestPaid.add(interestDai);
        daiBalance = receipt.daiBalance;
        gasDai = gasDai.add(receipt.gasDai);
        totalPTsCollateralized = totalPTsCollateralized.add(ptBalance);
        cycles++;
      }
    }
  })();

  // Gas for buying fiat, settling collateral, redeeming PTs and flash loans if we need it
  const settlementGasData = await getSettlementGasDai(usesFlashLoan);
  gasDai = gasDai.add(settlementGasData);
  totalDaiEarned = totalDaiEarned.sub(gasDai);

  // If flash loan, add flash loan fee
  if (usesFlashLoan) {
    const flashLoanInterestRate = ethers.utils.parseUnits(FLASH_LOAN_INTEREST.toString(), DECIMALS);
    const flashLoanInterest = dsMath.wmul(totalDaiUsedToPurchasePTs, flashLoanInterestRate);
    gasDai = gasDai.add(flashLoanInterest);
    totalDaiEarned = totalDaiEarned.sub(flashLoanInterest);
  }

  const earnedFixed = Number(ethers.utils.formatUnits(totalDaiEarned, DECIMALS));

  const netAPY = earnedFixed/startingDaiBalanceFixed/MATURITY_YEAR_FACTOR;

  console.log("Final Net APY: ", netAPY);

  return {
    cycles,
    gasDai,
    startingDaiBalance,
    totalDaiEarned,
    totalInterestPaid,
    daiBalance,
    totalPTsCollateralized,
    netAPY,
  }
}

async function leverageCycle(amount, noGasTracking) {
  const signer = (await ethers.getSigners())[0];

  const startingEth = await signer.getBalance();

  await updateGasPriceIfNecesary('before purchasePTs 1');
  const ptBalance = await purchasePTs(amount, 0);
  const fiatDebt = await collateralizeForFiat();
  const daiBalance = await curveSwapFiatForDai();

  const endingEth = await signer.getBalance();

  // If using a flash loan we can turn off the gas costs subsequent cycles
  let gasDai;
  if (noGasTracking) {
    gasDai = BigNumber.from(0);
  } else {
    gasDai = dsMath.wmul(startingEth.sub(endingEth), ETH_PRICE_DAI);
  }

  const interestDai = dsMath.wmul(fiatDebt, ethers.utils.parseUnits((MATURITY_YEAR_FACTOR * FIAT_INTEREST_RATE * FIAT_PRICE_DAI).toFixed(DECIMALS).toString(), DECIMALS));
  const daiBalanceOnMaturity = ptBalance.sub(gasDai).sub(interestDai).add(daiBalance).sub(dsMath.wmul(fiatDebt, ethers.utils.parseUnits(Number(FIAT_PRICE_DAI).toString())));
  const daiEarned = daiBalanceOnMaturity.sub(amount);

  console.log("Dai Balance on Maturity: ", ethers.utils.formatUnits(daiBalanceOnMaturity, DECIMALS));
  console.log("Dai Gained: ", ethers.utils.formatUnits(daiEarned, DECIMALS));

  return {
    gasDai,
    interestDai,
    daiBalanceOnMaturity,
    daiBalance,
    daiEarned,
    ptBalance
  }
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

  await daiERC20Whale.transfer(signer.address, daiAmount);
  const balanceOfSigner = await daiERC20Whale.balanceOf(signer.address);

  console.log("confirmed transferred balance: ", balanceOfSigner);
}

async function purchasePTs(amount) {
  const signer = (await ethers.getSigners())[0];
  await updateGasPriceIfNecesary('before purchasePTs 1.5');

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
  const bal = await daiERC20.balanceOf(signer.address);

  await updateGasPriceIfNecesary('before purchasePTs 2');
  receipt = await ccPool.swap(singleSwap, funds, limit, deadline);
  console.log(`purchased PTs with gas price ${hre.ethers.utils.formatUnits(receipt.gasPrice,9)} on block ${receipt.blockNumber}`);

  const ptERC20 = await ethers.getContractAt("ERC20", daiPTAddress, signer);
  const ptBalance = await ptERC20.balanceOf(signer.address);

  console.log("PTs Acquired: ", ethers.utils.formatUnits(ptBalance, DECIMALS));

  return ptBalance;
}

async function collateralizeForFiat() {
  const signer = (await ethers.getSigners())[0];

  const vault = await ethers.getContractAt("IVaultEPT", fiatDaiVaultAddress, signer);

  // This method of calculating takes into account the accumulator interest
  // this means you can never be liquidated
  const fairPrice = await vault.fairPrice(0, true, false);

  const ptERC20 = await ethers.getContractAt("ERC20", daiPTAddress, signer);
  const ptBalance = await ptERC20.balanceOf(signer.address);

  const fiatActions = await ethers.getContractAt("VaultEPTActions", fiatActionAddress, signer);

  // Max debt that can be acquired, not normalized
  const maxDebt = dsMath.wmul(fairPrice, ptBalance);
  const publicanAddress = await fiatActions.publican();
  const publican = await hre.ethers.getContractAt("IPublican", publicanAddress);
  const virtualRate = await publican.callStatic.virtualRate(fiatDaiVaultAddress);
  const normalizedDebt = dsMath.wdiv(maxDebt, virtualRate);

  console.log("Max Debt: ", maxDebt);
  console.log("Normalized Debt: ", normalizedDebt);

  const proxyFactory = await ethers.getContractAt("IPRBProxyFactory", fiatProxyFactoryAddress);
  var receipt = await proxyFactory.deployFor(signer.address);
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
      normalizedDebt
    ]
  );

  await updateGasPriceIfNecesary("before collateralizeForFiat");
  var receipt = await userProxy.execute(fiatActionAddress, functionData);
  console.log(`collateralized for fiat with gas price ${hre.ethers.utils.formatUnits(receipt.gasPrice,9)} on block ${receipt.blockNumber}`);

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
  await updateGasPriceIfNecesary("before curve swap");
  receipt = await curvePool.exchange_underlying(0, 1, fiatBalance, BigNumber.from("0"), signer.address);
  console.log(`swapped in curve with gas price ${hre.ethers.utils.formatUnits(receipt.gasPrice,9)} on block ${receipt.blockNumber}`);

  const daiERC20 = await ethers.getContractAt("ERC20", daiAddress, signer);
  const newDaiBalance = await daiERC20.balanceOf(signer.address);
  
  console.log("Swapped and received Dai: ", ethers.utils.formatUnits(newDaiBalance, DECIMALS));

  return newDaiBalance;
}

async function getSettlementGasDai(usesFlashLoan) {
  const signer = (await ethers.getSigners())[0];

  // for now just hardcode the amounts
  const settlementLimits = {
    modifyCollateralAndDebt: ethers.utils.parseUnits("317540", DECIMALS),
    approveDaiCurve: ethers.utils.parseUnits("46458", DECIMALS),
    swapDaiForFiat: ethers.utils.parseUnits("276871", DECIMALS),
    redeemPTs: ethers.utils.parseUnits("145141", DECIMALS),
    ...(usesFlashLoan) && {flashLoan: ethers.utils.parseUnits("204493", DECIMALS) },
  };

  // get gas price through alchemy
  const daiERC20 = await ethers.getContractAt("ERC20", daiAddress, signer);
  const tx = await daiERC20.approve(fiatCurvePoolAddress, MAX_APPROVE);
  const receipt = await tx.wait();
  const gasPrice = ethers.utils.parseUnits(receipt.effectiveGasPrice.toString(), "wei");

  let totalGasSpent = BigNumber.from(0);
  for (const key in settlementLimits) {
    totalGasSpent = totalGasSpent.add(dsMath.wmul(gasPrice, settlementLimits[key]));
  }


  const totalGasSpentDai = dsMath.wdiv(totalGasSpent, ethers.utils.parseUnits(DAI_PRICE_ETH.toString(), DECIMALS));

  console.log("settlement gas spent in DAI: ", ethers.utils.formatUnits(totalGasSpentDai, DECIMALS));
  return totalGasSpentDai;
}


// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
