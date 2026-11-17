import { defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: {
    version: "0.8.34",
  },
  // The contract lives in ./contract (Hardhat's default would be ./contracts)
  paths: {
    sources: "./contract",
  },
  networks: {
    // The chain started by `npx hardhat node`
    localhost: {
      type: "http",
      url: "http://127.0.0.1:8545",
    },
  },
});
