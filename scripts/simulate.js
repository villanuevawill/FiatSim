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
const ptPoolID = "0x8ffd1dc7c3ef65f833cf84dbcd15b6ad7f9c54ec000200000000000000000199";
const balancerVaultAddress = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const fiatActionAddress = "0x0021DCEeb93130059C2BbBa7DacF14fe34aFF23c";
const fiatDaiVaultAddress = "0xb6922A39C85a4E838e1499A8B7465BDca2E49491";
const fiatProxyFactoryAddress = "0x7Ee06e44C4764A49346290CD9a2267DB6daD7214";
const fiatAddress = "0x586Aa273F262909EEF8fA02d90Ab65F5015e0516";
const fiatCurvePoolAddress = "0xDB8Cc7eCeD700A4bfFdE98013760Ff31FF9408D8";

const MAX_APPROVE = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

async function main() {
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

  const daiERC20Whale = await ethers.getContractAt("ERC20", daiAddress, daiWhaleSigner);

  const decimals = await daiERC20Whale.decimals()
  const amountAbsolute = ethers.utils.parseUnits("100000", decimals);
  const transaction = await daiERC20Whale.transfer(signer.address, amountAbsolute);
  const balanceOfSigner = await daiERC20Whale.balanceOf(signer.address);

  console.log("confirmed transferred balance: ", balanceOfSigner);

  const ccPool =  await new ethers.Contract(balancerVaultAddress, ivault, signer);

  const singleSwap = {
    poolId: ptPoolID,
    kind: 0, // GIVEN_IN
    assetIn: daiAddress,
    assetOut: daiPTAddress,
    amount: ethers.utils.parseUnits("100000.0"),
    userData: "0x00",
  };

  const funds = {
    sender: signer.address,
    recipient: signer.address,
    fromInternalBalance: false,
    toInternalBalance: false,
  };

  limit = ethers.utils.parseUnits("100000.0"); // For now don't worry about limit since it is a sim
  deadline = Math.round(Date.now() / 1000) + 100; // 100 seconds expiration

  const ptERC20 = await ethers.getContractAt("ERC20", daiPTAddress, signer);
  const daiERC20 = await ethers.getContractAt("ERC20", daiAddress, signer);
  await daiERC20.approve(balancerVaultAddress, MAX_APPROVE);
  await ccPool.swap(singleSwap, funds, limit, deadline);

  const ptBalance = await ptERC20.balanceOf(signer.address);
  console.log("PTs Acquired: ", ethers.utils.formatUnits(ptBalance, decimals));

  const vault = await ethers.getContractAt("IVaultEPT", fiatDaiVaultAddress, signer);

  // This method of calculating takes into account the accumulator interest
  // this means you can never be liquidated
  const fairPrice = await vault.fairPrice(0, true, false);
  console.log("original fair price: ", fairPrice);

  // Max debt that can be acquired
  const maxDebt = dsMath.wmul(fairPrice, ptBalance);
  console.log("Fair Price: ", ethers.utils.formatUnits(fairPrice, decimals));
  console.log("Max Debt: ", ethers.utils.formatUnits(maxDebt, decimals));

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
      maxDebt.sub(ethers.utils.parseUnits("60", 18))
    ]
  );

  await userProxy.execute(fiatActionAddress, functionData);

  const fiatERC20 = await ethers.getContractAt("ERC20", fiatAddress, signer);
  const fiatBalance = await fiatERC20.balanceOf(signer.address);

  console.log("Current Fiat Balance: ", ethers.utils.formatUnits(fiatBalance, decimals));

  await fiatERC20.approve(fiatCurvePoolAddress, MAX_APPROVE);
  const curvePool = await ethers.getContractAt("ICurveFi", fiatCurvePoolAddress, signer);
  await curvePool.exchange_underlying(0, 1, fiatBalance, BigNumber.from("0"), signer.address);

  const newDaiBalance = await daiERC20.balanceOf(signer.address);
  console.log("Swapped and received Dai: ", newDaiBalance);
}


// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
