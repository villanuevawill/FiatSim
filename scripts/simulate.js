// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// When running the script with `npx hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
const { BigNumber } = require("ethers");
const hre = require("hardhat");
const ivault = require("../artifacts/contracts/balancer-core-v2/vault/interfaces/IVault.sol/IVault.json").abi;
const dsMath = require("../helpers/dsmath-ethers");
var latestBlockNumber = 0

let Vault = class {
  constructor(totalNormalDebt, rate, debtCeiling, debtFloor) {
    this.totalNormalDebt = totalNormalDebt/10**18; // Total Normalised Debt in Vault
    this.rate = rate/10**18; // Vault's Accumulation Rate
    this.debtCeiling = debtCeiling/10**18; // Vault's Debt Ceiling
    this.debtFloor = debtFloor/10**18; // Debt Floor for Positions corresponding to this Vault
    this.totalNormalDebtWAD = totalNormalDebt; // Total Normalised Debt in Vault [wad]
    this.rateWAD = rate; // Vault's Accumulation Rate [wad]
    this.debtCeilingWAD = debtCeiling; // Vault's Debt Ceiling [wad]
    this.debtFloorWAD = debtFloor; // Debt Floor for Positions corresponding to this Vault [wad]
  }
}

const daiWhaleAddress = "0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503";
const daiAddress = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const daiPTAddress = "0xCCE00da653eB50133455D4075fE8BcA36750492c";
const balancerVaultAddress = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const fiatActionAddress = "0x0021DCEeb93130059C2BbBa7DacF14fe34aFF23c";
const fiatDaiVaultAddress = "0xb6922A39C85a4E838e1499A8B7465BDca2E49491";
const fiatProxyFactoryAddress = "0x7Ee06e44C4764A49346290CD9a2267DB6daD7214";
const fiatAddress = "0x586Aa273F262909EEF8fA02d90Ab65F5015e0516";

const elementDaiTrancheAddresses = {
  "address": "0xCCE00da653eB50133455D4075fE8BcA36750492c",
  "trancheFactory": "0x62F161BF3692E4015BefB05A03a94A40f520d1c0",
  "expiration": 1663361092,
  "ptPool": {
    "address": "0x8fFD1dc7C3eF65f833CF84dbCd15b6Ad7f9C54EC",
    "poolId": "0x8ffd1dc7c3ef65f833cf84dbcd15b6ad7f9c54ec000200000000000000000199",
    "fee": "0.1",
    "timeStretch": 55.47
  },
  "weightedPoolFactory": "0x8E9aa87E45e92bad84D5F8DD1bff34Fb92637dE9",
  "convergentCurvePoolFactory": "0xE88628700eaE9213169D715148ac5A5F47B5dCd9"
};

async function printBlockNumber(text) {
  if (typeof(text) != "undefined") {text = ' ' + text} else {text = ''}
  const newBlockNumber = await hre.ethers.provider.getBlockNumber();
  if (newBlockNumber > latestBlockNumber) {
    console.log("Block Number: " + newBlockNumber + text);
    latestBlockNumber = newBlockNumber;
  }
}

async function main() {
  const signer = (await hre.ethers.getSigners())[0];
  printBlockNumber('init')

  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [daiWhaleAddress],
  });
  const daiWhaleSigner = await hre.ethers.getSigner(daiWhaleAddress)

  // Send some ether to the holder so that they can transfer tokens
  await hre.network.provider.send("hardhat_setBalance", [
    daiWhaleAddress,
    hre.ethers.utils.parseEther("10.0").toHexString()
  ]);

  const daiERC20Whale = await hre.ethers.getContractAt("ERC20", daiAddress, daiWhaleSigner);
  const decimals = await daiERC20Whale.decimals()
  const amountAbsolute = hre.ethers.utils.parseUnits("100000", decimals);
  const transaction = await daiERC20Whale.transfer(signer.address, amountAbsolute);
  printBlockNumber('transfer ether from whale')
  const balanceOfSigner = await daiERC20Whale.balanceOf(signer.address);
  // console.log("confirmed transferred balance: ", balanceOfSigner);
  const ccPool =  await new hre.ethers.Contract(balancerVaultAddress, ivault, signer);

  const singleSwap = {
    poolId: elementDaiTrancheAddresses.ptPool.poolId,
    kind: 0, // GIVEN_IN
    assetIn: daiAddress,
    assetOut: daiPTAddress,
    amount: hre.ethers.utils.parseUnits("100000.0"),
    userData: "0x00",
  };

  const funds = {
    sender: signer.address,
    recipient: signer.address,
    fromInternalBalance: false,
    toInternalBalance: false,
  };

  limit = hre.ethers.utils.parseUnits("100000.0"); // For now don't worry about limit since it is a sim
  deadline = Math.round(Date.now() / 1000) + 100; // 100 seconds expiration

  const ptERC20 = await hre.ethers.getContractAt("ERC20", daiPTAddress, signer);
  const daiERC20 = await hre.ethers.getContractAt("ERC20", daiAddress, signer);
  printBlockNumber('approve dai and pt for signer')
  await daiERC20.approve(balancerVaultAddress, "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  await ccPool.swap(singleSwap, funds, limit, deadline);
  printBlockNumber('balancer swap')

  const ptBalance = await ptERC20.balanceOf(signer.address);
  const vault = await hre.ethers.getContractAt("IVaultEPT", fiatDaiVaultAddress, signer);
  const fiatActions = await hre.ethers.getContractAt("VaultEPTActions", fiatActionAddress, signer);

  const proxyFactory = await hre.ethers.getContractAt("IPRBProxyFactory", fiatProxyFactoryAddress);
  const receipt = await proxyFactory.deployFor(signer.address);
  const receiptData = await receipt.wait();
  const proxyAddress = receiptData.events?.filter(x => x.event == 'DeployProxy')[0].args.proxy;
  printBlockNumber('deploy proxy')

  const userProxy = await hre.ethers.getContractAt("IPRBProxy", proxyAddress);
  await daiERC20.approve(proxyAddress, "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  await ptERC20.approve(proxyAddress, proxyAddress);
  printBlockNumber('approve dai and pt for proxy')

  // This method of calculating takes into account the accumulator interest
  // this means you can never be liquidated
  var fairPrice = await vault.fairPrice(0, true, false);

  // Max debt that can be acquired
  const maxDebt = dsMath.wmul(fairPrice, ptBalance);
  console.log("Fair Price: ", hre.ethers.utils.formatUnits(fairPrice, decimals));
  console.log("Max Debt: ", hre.ethers.utils.formatUnits(maxDebt, decimals));

  const publican = await hre.ethers.getContractAt("IPublican", await fiatActions.publican());
  const virtualRate = await publican.virtualRate(fiatDaiVaultAddress)
  console.log('Virtual rate from publican: ' + virtualRate.value.toString())
  const codex = await hre.ethers.getContractAt("ICodex", await fiatActions.codex());
  var fiatDaiVault = new Vault(...await codex.vaults(fiatDaiVaultAddress))
  console.log(fiatDaiVault)
  console.log('Virtual rate from codex: ' + fiatDaiVault.rate.toString())
  printBlockNumber('get virtual rates')

  debtDecrement=0
  tryDebt = dsMath.wdiv(maxDebt, dsMath.wmul(fiatDaiVault.rateWAD,hre.ethers.utils.parseUnits("1.00001", 18))) // adjust for change in rate over time until execution
  success = false
  while (!success) {
    tryDebt = tryDebt.sub(hre.ethers.utils.parseUnits(debtDecrement.toString(), 18))

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
        tryDebt
      ]
    );
    try {
      await userProxy.execute(fiatActionAddress, functionData)
      console.log('success minting debt with inputs:'
        +'\n  actual FIAT debt = '+(tryDebt/10**decimals*fiatDaiVault.rate).toString()
        +'\n  normalized FIAT debt = '+(tryDebt/10**decimals).toString()
        +'\n  debtDecrement=' + debtDecrement.toString()
        )
      success = true
    }
    catch(e) {
      console.log('failed taking out normalized FIAT debt = '+(tryDebt/10**decimals).toString()+', decrement='+debtDecrement.toString())
      debtDecrement++
    }
  } // end while
  printBlockNumber('take out debt')

  oldRate = fiatDaiVault.rate
  var fiatDaiVault = new Vault(...await codex.vaults(fiatDaiVaultAddress))
  newRate = fiatDaiVault.rate
  printBlockNumber('update normalization rate')

  const fiatERC20 = await hre.ethers.getContractAt("ERC20", fiatAddress, signer);
  const fiatBalance = await fiatERC20.balanceOf(signer.address);
  const fiatNormalBalance = dsMath.wdiv(fiatBalance,fiatDaiVault.rateWAD);
  
  console.log("Current balance:"
    +'\n  Actual Fiat: '+hre.ethers.utils.formatUnits(fiatBalance, decimals)
    +'\n  Normalized Fiat: '+hre.ethers.utils.formatUnits(fiatNormalBalance, decimals));
}

async function debugNormalizationRate() {
  console.log("Current Fiat Balance: ", hre.ethers.utils.formatUnits(fiatBalance, decimals));
  console.log("Current Fiat Normalized Balance: ", hre.ethers.utils.formatUnits(fiatNormalBalance, decimals));

  difference = fiatNormalBalance - tryDebt
  differenceActual = fiatBalance - dsMath.wmul(tryDebt,fiatDaiVault.rateWAD)
  console.log('difference in Normal Debt: input minus output: ' + difference/10**decimals + ' (' + difference/tryDebt*100 + '%)')
  console.log('difference in Actual Debt: input minus output: ' + differenceActual/10**decimals + ' (' + differenceActual/dsMath.wmul(tryDebt,fiatDaiVault.rateWAD)*100 + '%)')

  console.log('new normalization rate: ' + fiatDaiVault.rate.toString())
  console.log('increase in rate: ' + (newRate/oldRate-1)*100 +'%')
  differenceActual = fiatBalance - dsMath.wmul(tryDebt,fiatDaiVault.rateWAD)
  console.log('difference in Actual Debt using new normalization rate: ' + differenceActual/10**decimals + ' (' + differenceActual/dsMath.wmul(tryDebt,fiatDaiVault.rateWAD)*100 + '%)')
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
