require("dotenv").config();
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-waffle");
require('@openzeppelin/hardhat-upgrades');

// This is a sample Hardhat task. To learn how to create your own go to
// https://hardhat.org/guides/create-task.html

task("accounts", "Prints the list of accounts", async (taskArgs, hre) => {
  const accounts = await hre.ethers.getSigners();

  for (const account of accounts) {
    console.log(account.address);
  }
});

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.6.12",
      },
      {
        version: "0.7.3",
      },
      {
        version: "0.8.0",
      },
      {
        version: "0.8.4",
      },
    ]
  },
  networks: {
    hardhat: {
      hardfork: "london",
      accounts: [
        {
          balance: "10000000000000000000000",
          privateKey: process.env.PRIVATE_KEY,
        },
      ],
      forking: {
        url: process.env.ALCHEMY_URL,
        blockNumber: Number(process.env.BLOCK_NUMBER)
      },
      mining: {
        auto: false,
        interval: 0,
        mempool: {
          order: "fifo"
        }
      }
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
};
