// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// When running the script with `npx hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
const hre = require("hardhat");


const daiWhaleAddress = "0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503";
const daiAddress = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

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
    hre.ethers.utils.parseEther('10.0').toHexString()
  ]);

  const ERC20 = await hre.ethers.getContractAt("ERC20", daiAddress, daiWhaleSigner);

  const decimals = await ERC20.decimals()
  const amountAbsolute = hre.ethers.utils.parseUnits("10000", decimals);
  const transaction = await ERC20.transfer(signer.address, amountAbsolute);
  const balanceOfSigner = await ERC20.balanceOf(signer.address);

  console.log("confirmed transferred balance: ", balanceOfSigner);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
