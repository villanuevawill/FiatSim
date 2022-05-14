// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// When running the script with `npx hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
const { BigNumber } = require("ethers");
const hre = require("hardhat");
const ivault = require("../artifacts/contracts/balancer-core-v2/vault/interfaces/IVault.sol/IVault.json").abi;
const dsMath = require("../helpers/dsmath-ethers");

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

async function main() {
  const signer = (await hre.ethers.getSigners())[0];

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
  const balanceOfSigner = await daiERC20Whale.balanceOf(signer.address);

  console.log("confirmed transferred balance: ", balanceOfSigner);

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
  await daiERC20.approve(balancerVaultAddress, "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  await ccPool.swap(singleSwap, funds, limit, deadline);

  const ptBalance = await ptERC20.balanceOf(signer.address);
  console.log("PTs Acquired: ", hre.ethers.utils.formatUnits(ptBalance, decimals));

  const vault = await hre.ethers.getContractAt("IVaultEPT", fiatDaiVaultAddress, signer);

  // This method of calculating takes into account the accumulator interest
  // this means you can never be liquidated
  const fairPrice = await vault.fairPrice(0, true, false);
  console.log("original fair price: ", fairPrice);

  // Max debt that can be acquired
  const maxDebt = dsMath.wmul(fairPrice, ptBalance);
  console.log("Fair Price: ", hre.ethers.utils.formatUnits(fairPrice, decimals));
  console.log("Max Debt: ", hre.ethers.utils.formatUnits(maxDebt, decimals));

  const fiatActions = await hre.ethers
  .getContractAt("VaultEPTActions", fiatActionAddress, signer);

  const proxyFactory = await hre.ethers.getContractAt("IPRBProxyFactory", fiatProxyFactoryAddress);
  const receipt = await proxyFactory.deployFor(signer.address);
  const receiptData = await receipt.wait();
  const proxyAddress = receiptData.events?.filter(x => x.event == 'DeployProxy')[0].args.proxy;

  const userProxy = await hre.ethers.getContractAt("IPRBProxy", proxyAddress);
  await daiERC20.approve(proxyAddress, "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  await ptERC20.approve(proxyAddress, proxyAddress);

  // For now comment out if we want to be more efficient and use this later
  // const functionData = fiatActions.interface.encodeFunctionData(
  //   'buyCollateralAndModifyDebt',
  //   [
  //     fiatDaiVaultAddress,
  //     proxyAddress,
  //     signer.address,
  //     signer.address,
  //     hre.ethers.utils.parseUnits("1000", 18),
  //     hre.ethers.utils.parseUnits("500", 18),
  //     [
  //       balancerVaultAddress,
  //       elementDaiTrancheAddresses.ptPool.poolId,
  //       daiAddress,
  //       daiPTAddress,
  //       hre.ethers.utils.parseUnits("1000", 18),
  //       deadline,
  //       hre.ethers.utils.parseUnits("1000", 18),
  //     ]
  //   ]
  // );

  debtDecrement=0
  success = false
  while (!success) {
    debtDecrement++
    tryDebt = maxDebt.sub(hre.ethers.utils.parseUnits(debtDecrement.toString(), 18))

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
      console.log('success taking out FIAT debt = '+(tryDebt/10**decimals).toString()+', decrement='+debtDecrement.toString())
      success = true
    }
    catch(e) { console.log('failed taking out FIAT debt = '+(tryDebt/10**decimals).toString()+', decrement='+debtDecrement.toString()) }
  } // end while

  const fiatERC20 = await hre.ethers.getContractAt("ERC20", fiatAddress, signer);
  const fiatBalance = await fiatERC20.balanceOf(signer.address);

  console.log("Current Fiat Balance: ", hre.ethers.utils.formatUnits(fiatBalance, decimals));
}


// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
