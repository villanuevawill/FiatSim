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
const FIAT_PRICE_DAI = 1; // just used on maturity for the buyback price
const GAS_PRICE = 17; // in gwei

const FLASH_LOAN_INTEREST = .0009;

const DAI_BALANCE_START = 2000; // original 10000
const DAI_BALANCE_INCREMENT = 2000; // original 2000
const DAI_BALANCE_END = 200000; // original 50000

async function updateGasPriceIfNecesary(text) {
  feeDataOld = await hre.ethers.provider.getFeeData()
  if (Number(hre.ethers.utils.formatUnits(feeDataOld.gasPrice,9)) != GAS_PRICE) {
    await network.provider.send("hardhat_setNextBlockBaseFeePerGas",[`0x${Number((GAS_PRICE-1)*1e9).toString(16)}`]);
    feeDataNew = await hre.ethers.provider.getFeeData()
    blockNumber = await hre.ethers.provider.getBlockNumber()
    // console.log(`${text} new Block ${blockNumber}: gas price from ${hre.ethers.utils.formatUnits(feeDataOld.gasPrice,9)} to ${hre.ethers.utils.formatUnits(feeDataNew.gasPrice,9)}`);
  }
  return blockNumber
}

async function mineNextBlock(text) {
  const blockNumber = await updateGasPriceIfNecesary(text);
  await hre.ethers.provider.send("evm_mine", []);
  const block = await hre.ethers.provider.getBlock(blockNumber);
  console.log(`${text} block #${block.number} executed with ${block.transactions.length} transactions at baseFeePerGas ${hre.ethers.utils.formatUnits(block.baseFeePerGas,9)}`);
}

async function main() {
  // update to use tasks instead of redundancy
  await simulate();
  // await simulate(true);
}

async function simulate(usesFlashLoan) {
  let daiBalance = ethers.utils.parseUnits(Number(DAI_BALANCE_START).toString(), DECIMALS);
  let runCount=0;
  await (async () => {
    for (let i = DAI_BALANCE_START; i <= DAI_BALANCE_END; i += DAI_BALANCE_INCREMENT) {
      runCount++
      const output = await fiatLeverage(i, usesFlashLoan);
      const serialized = {run: runCount};
      for (const [key, value] of Object.entries(output)) {
        if (value instanceof BigNumber) {
          serialized[key] = Number(ethers.utils.formatUnits(value, DECIMALS));
        } else {
          serialized[key] = value;
        }
      }
      
      const outputData = [];
      outputData.push(serialized);
      console.log("output entry: ", serialized);
    
      const data = JSON.stringify(outputData);
      await resetHardhat();
    }
  })()

  fs.writeFile(usesFlashLoan ? "fiatsim_flashloan.json" : 'fiatsim.json', data, (err) => {
    if (err) {
      throw err;
    }
    console.log(`JSON data is saved.`);
  });
}

async function resetHardhat() {
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

async function fiatLeverage(amount, usesFlashLoan, runCount) {
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
  let daiBalanceOnMaturity = ethers.utils.parseUnits("0");
  let firstCycleGasDai = ethers.utils.parseUnits("0");
  let finalAPY = ethers.utils.parseUnits("0");

  let cycles = 0;
  await (async () => {
    while (daiBalanceOnMaturity.gte(BigNumber.from(0))) {
      const receipt = await leverageCycle(daiBalance, usesFlashLoan && cycles > 0, cycles);

      if (cycles === 0) {
        firstCycleGasDai = receipt.gasDai;
      }

      daiBalanceOnMaturity = receipt.daiBalanceOnMaturity;

      // count aggregate stats only when we want to 
      if (daiBalanceOnMaturity.gte(BigNumber.from(0)) || cycles === 0) {
        totalDaiUsedToPurchasePTs = totalDaiUsedToPurchasePTs.add(ethers.utils.parseUnits(amount.toString(), DECIMALS));
        totalDaiEarned = totalDaiEarned.add(daiBalanceOnMaturity);
        totalInterestPaid = totalInterestPaid.add(receipt.fiatInterestinDai);
        daiBalance = receipt.daiBalance;
        gasDai = gasDai.add(receipt.gasDai);
        totalPTsCollateralized = totalPTsCollateralized.add(receipt.ptBalance);

        // Gas for buying fiat, settling collateral, redeeming PTs and flash loans if we need it
        const settlementGas = await getSettlementGasDai(usesFlashLoan);
        const ptsBought = await purchasePTs(daiBalance, true);
        const finalDaiEarned = totalDaiEarned.sub(settlementGas).sub(daiBalance).add(ptsBought);

        const earnedFixed = Number(ethers.utils.formatUnits(finalDaiEarned, DECIMALS));
        finalAPY = earnedFixed/startingDaiBalanceFixed/MATURITY_YEAR_FACTOR;

        console.log(`aggregate cycle${cycles}: calculation:
        + Total Dai Earned   : ${Math.round(hre.ethers.utils.formatUnits(totalDaiEarned, 18))}
        - Settlement Gas     : ${Math.round(hre.ethers.utils.formatUnits(settlementGas, 18))}
        - Dai on Hand        : ${Math.round(hre.ethers.utils.formatUnits(daiBalance, 18))}
        + PTs bought         : ${Math.round(hre.ethers.utils.formatUnits(ptsBought,18))}
          = Final Dai Earned : ${Math.round(hre.ethers.utils.formatUnits(finalDaiEarned, 18))}
        = final APY          : ${Math.round(finalAPY * 100 * 100) / 100}%`);

        cycles++;
      }

      // show aggregate stats only on the last loop
      if (daiBalanceOnMaturity.lt(BigNumber.from(0))) {
        console.log(`Leverage loop finished
  Fiat down to: ${receipt.effectiveFiatPrice}
  Reserves to [Dai: ${Math.round(hre.ethers.utils.formatUnits(receipt.reservesDai,18))}, Fiat ${Math.round(hre.ethers.utils.formatUnits(receipt.reservesFiat,18))}]
  FIAT makes up ${receipt.fiatPoolShare}% of the reserves`)
      }
    }
  })();

  // If flash loan, add flash loan fee
  if (usesFlashLoan) {
    gasDai = firstCycleGasDai;
    const flashLoanInterestRate = ethers.utils.parseUnits(FLASH_LOAN_INTEREST.toString(), DECIMALS);
    const flashLoanInterest = dsMath.wmul(totalDaiUsedToPurchasePTs, flashLoanInterestRate);

    totalDaiEarned = totalDaiEarned.sub(flashLoanInterest);
    totalDaiEarned = totalDaiEarned.sub(gasDai);
  }

  return {
    cycles,
    gasDai,
    startingDaiBalance,
    totalDaiEarned,
    totalInterestPaid,
    daiBalance,
    totalPTsCollateralized,
    finalAPY,
  }
}

async function leverageCycle(amount, noGasTracking, cycle) {
  const signer = (await ethers.getSigners())[0];

  const startingEth = await signer.getBalance();
  const ptBalance = await purchasePTs(amount);
  const fiatBalance = await collateralizeForFiat();
  const {daiBalance,effectiveFiatPrice,reservesDai,reservesFiat,fiatPoolShare} = await curveSwapFiatForDai();

  const endingEth = await signer.getBalance();

  // If using a flash loan we can turn off the gas costs subsequent cycles
  gasDai = dsMath.wmul(startingEth.sub(endingEth), ETH_PRICE_DAI);

  let daiBalanceOnMaturity = noGasTracking ? BigNumber.from(0) : BigNumber.from(0).sub(gasDai);
  const fiatDebtInDai = dsMath.wmul(fiatBalance, ethers.utils.parseUnits(Number(effectiveFiatPrice).toString()));
  const fiatInterestinDai = dsMath.wmul(fiatBalance, ethers.utils.parseUnits((MATURITY_YEAR_FACTOR * FIAT_INTEREST_RATE * FIAT_PRICE_DAI).toFixed(DECIMALS).toString(), DECIMALS));
  daiBalanceOnMaturity = daiBalanceOnMaturity.add(ptBalance).sub(fiatInterestinDai).sub(fiatDebtInDai).sub(amount).add(daiBalance);
  const netAPY = daiBalanceOnMaturity/amount/MATURITY_YEAR_FACTOR;

  console.log(`cycle${cycle}: profit calculation:
  - start with Dai     : ${Math.round(hre.ethers.utils.formatUnits(amount.toString(),18))}
  + swap for PTs       : ${Math.round(hre.ethers.utils.formatUnits(ptBalance.toString(),18))}
    = receive interest : ${Math.round(hre.ethers.utils.formatUnits(ptBalance.sub(amount).toString(),18))}
  - pay interest       : ${Math.round(hre.ethers.utils.formatUnits(fiatInterestinDai.toString(),18))}
    = net interest     : ${Math.round(hre.ethers.utils.formatUnits(ptBalance.sub(amount).sub(fiatInterestinDai).toString(),18))}
  - pay back FIAT      : ${Math.round(hre.ethers.utils.formatUnits(fiatDebtInDai.toString(),18))}
  + leftover Dai       : ${Math.round(hre.ethers.utils.formatUnits(daiBalance.toString(),18))}
  - pay gas            : ${Math.round(hre.ethers.utils.formatUnits(gasDai.toString(),18))}
  = Dai at maturity    : ${Math.round(hre.ethers.utils.formatUnits(daiBalanceOnMaturity.toString(),18))}
  = net APY            : ${Math.round(netAPY * 100 * 100) / 100}%`);

  return {
    gasDai,
    fiatInterestinDai,
    daiBalanceOnMaturity,
    daiBalance,
    ptBalance,
    fiatDebtInDai,
    effectiveFiatPrice,
    reservesDai,
    reservesFiat,
    fiatPoolShare
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
  await mineNextBlock("Seeding Dai");
  const balanceOfSigner = await daiERC20Whale.balanceOf(signer.address);

  console.log("confirmed transferred balance: ", balanceOfSigner);
}

async function purchasePTs(amount, staticCall) {
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

  let ptBalance = BigNumber.from(0);

  if (staticCall) {
    ptBalance = await ccPool.callStatic.swap(singleSwap, funds, limit, deadline);
  } else {
    await daiERC20.approve(balancerVaultAddress, MAX_APPROVE);
    await ccPool.swap(singleSwap, funds, limit, deadline);
    await mineNextBlock(`purchasePTs`);
    const ptERC20 = await ethers.getContractAt("ERC20", daiPTAddress, signer);
    ptBalance = await ptERC20.balanceOf(signer.address);
  }

  console.log(`PTs Acquired: `, ethers.utils.formatUnits(ptBalance, DECIMALS));

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

  console.log(`Max Debt, Actual: ${hre.ethers.utils.formatUnits(maxDebt,18)}, Normalized: ${hre.ethers.utils.formatUnits(normalizedDebt,18)}`);

  const proxyFactory = await ethers.getContractAt("IPRBProxyFactory", fiatProxyFactoryAddress);

  const receipt = await proxyFactory.deployFor(signer.address);
  await mineNextBlock(`deployProxy`);
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

  await userProxy.execute(fiatActionAddress, functionData);
  await mineNextBlock(`collateralizeForFiat`);

  const fiatERC20 = await ethers.getContractAt("ERC20", fiatAddress, signer);
  const fiatBalance = await fiatERC20.balanceOf(signer.address);

  console.log(`Current Fiat Balance: ${ethers.utils.formatUnits(fiatBalance, DECIMALS)}`);

  return fiatBalance;
}

async function curveSwapFiatForDai() {
  const signer = (await ethers.getSigners())[0];

  // get contracts
  const fiatERC20 = await ethers.getContractAt("ERC20", fiatAddress, signer);
  const curvePool = await ethers.getContractAt("ICurveFi", fiatCurvePoolAddress, signer);
  const daiERC20 = await ethers.getContractAt("ERC20", daiAddress, signer);
  
  // do stuff with them
  const fiatBalance = await fiatERC20.balanceOf(signer.address);
  await fiatERC20.approve(fiatCurvePoolAddress, MAX_APPROVE);
  const oldDaiBalance = await daiERC20.balanceOf(signer.address);
  await curvePool.exchange_underlying(0, 1, fiatBalance, BigNumber.from("0"), signer.address);
  await mineNextBlock(`curveSwap`);
  const daiBalance = await daiERC20.balanceOf(signer.address);

  reservesDai = await curvePool.balances(0);  reservesFiat = await curvePool.balances(1);
  const effectiveFiatPrice = 1/(fiatBalance/(daiBalance-oldDaiBalance))
  const fiatPoolShare = Math.round(hre.ethers.utils.formatUnits(dsMath.wdiv(reservesFiat,(reservesFiat.add(reservesDai))),18)*100*10)/10
  console.log(`Swapped and received ${Math.round(ethers.utils.formatUnits(daiBalance, DECIMALS)*100)/100} Dai.
  Effective Price: ${effectiveFiatPrice}
  Reserves: [Dai: ${Math.round(hre.ethers.utils.formatUnits(reservesDai,18))}, Fiat: ${Math.round(hre.ethers.utils.formatUnits(reservesFiat,18))}]
  Fiat makes up ${fiatPoolShare}% of the pool`);

  return {daiBalance, effectiveFiatPrice, reservesDai, reservesFiat, oldDaiBalance, fiatPoolShare};
}

async function getSettlementGasDai(usesFlashLoan) {
  const signer = (await ethers.getSigners())[0];

  // for now just hardcode the amounts
  const settlementLimits = {
    modifyCollateralAndDebt: ethers.utils.parseUnits("317540", DECIMALS),
    approveDaiCurve: ethers.utils.parseUnits("46458", DECIMALS),
    swapDaiForFiat: ethers.utils.parseUnits("276871", DECIMALS),
    redeemPTs: ethers.utils.parseUnits("145141", DECIMALS),
    purchasePTs: ethers.utils.parseUnits("123246", DECIMALS),
    ...(usesFlashLoan) && {flashLoan: ethers.utils.parseUnits("204493", DECIMALS) },
  };

  let totalGasSpent = BigNumber.from(0);
  for (const key in settlementLimits) {
    totalGasSpent = totalGasSpent.add(dsMath.wmul(ethers.utils.parseUnits(GAS_PRICE.toString(), "gwei"), settlementLimits[key]));
  }

  const totalGasSpentDai = dsMath.wdiv(totalGasSpent, ethers.utils.parseUnits(DAI_PRICE_ETH.toString(), DECIMALS));

  console.log(`settlement gas spent in DAI: ${ethers.utils.formatUnits(totalGasSpentDai, DECIMALS)}`);
  return totalGasSpentDai;
}


// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
