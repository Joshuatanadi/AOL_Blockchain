// Deploys MedicalRecord and points the website (app.js) AND the backend (api.php) at the new contract.
//
//   npx hardhat node          <- terminal 1, keep it running
//   npm run deploy            <- terminal 2, after every restart of the node
//
// The deploying account (Hardhat account #0) becomes the Admin.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import hre from "hardhat";

const artifact = await hre.artifacts.readArtifact("MedicalRecord");
const connection = await hre.network.create();
const { provider } = connection;

const request = (method: string, params: unknown[] = []) =>
  provider.request({ method, params }) as Promise<any>;

const [deployer] = await request("eth_accounts");
if (!deployer) throw new Error("The network has no unlocked account to deploy from.");
const chainId = Number(await request("eth_chainId"));

const transactionHash = await request("eth_sendTransaction", [
  { from: deployer, data: artifact.bytecode },
]);

let receipt = null;
for (let attempt = 0; attempt < 60 && !receipt; attempt++) {
  receipt = await request("eth_getTransactionReceipt", [transactionHash]);
  if (!receipt) await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!receipt || receipt.status !== "0x1" || !receipt.contractAddress) {
  throw new Error("Deployment failed: " + JSON.stringify(receipt));
}
const contractAddress: string = receipt.contractAddress;

console.log(`MedicalRecord deployed on "${connection.networkName}" (chain ID ${chainId})`);
console.log(`  contract address : ${contractAddress}`);
console.log(`  admin (deployer) : ${deployer}`);

// Only a real, persistent node is worth pointing the website at; the in-memory
// network used by a plain `npx hardhat run` disappears when the script ends.
if (connection.networkConfig.type === "http") {
  const root = hre.config.paths.root;
  const appJsPath = path.join(root, "app.js");
  const apiPhpPath = path.join(root, "api.php");

  const appJsOriginal = await readFile(appJsPath, "utf8");
  const apiPhpOriginal = await readFile(apiPhpPath, "utf8");

  // app.js: SMART_CONTRACT_ADDRESS and EXPECTED_CHAIN_ID
  const appJsUpdated = appJsOriginal
    .replace(/const SMART_CONTRACT_ADDRESS = "[^"]*";/, () => `const SMART_CONTRACT_ADDRESS = "${contractAddress}";`)
    .replace(/const EXPECTED_CHAIN_ID = \d+;/, () => `const EXPECTED_CHAIN_ID = ${chainId};`);

  // api.php: the default value after  getenv("CONTRACT_ADDRESS") ?:
  const apiPhpUpdated = apiPhpOriginal.replace(
    /(getenv\("CONTRACT_ADDRESS"\) \?: )"0x[a-fA-F0-9]{40}"/,
    (_match, prefix) => `${prefix}"${contractAddress}"`,
  );

  // Check both files BEFORE writing either, so we never leave them out of sync.
  if (!appJsUpdated.includes(`"${contractAddress}"`) || !appJsUpdated.includes(`EXPECTED_CHAIN_ID = ${chainId};`)) {
    throw new Error("Could not find SMART_CONTRACT_ADDRESS / EXPECTED_CHAIN_ID in app.js; update them by hand.");
  }
  if (!apiPhpUpdated.includes(`"${contractAddress}"`)) {
    throw new Error('Could not find the CONTRACT_ADDRESS default in api.php; update it by hand (line with getenv("CONTRACT_ADDRESS")).');
  }

  await writeFile(appJsPath, appJsUpdated);
  await writeFile(apiPhpPath, apiPhpUpdated);
  console.log("app.js and api.php updated. Hard-refresh the website (Ctrl+F5).");
  console.log("Reminder: after restarting the Hardhat node, also run  TRUNCATE TABLE hospital_medical_records.users;");
} else {
  console.log('Dry run on the in-memory network; app.js and api.php not changed. Use "npm run deploy" for the real node.');
}

await connection.close();
