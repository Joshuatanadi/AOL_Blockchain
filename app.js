// config
// These two lines are rewritten by `npm run deploy` (scripts/deploy.ts)
const SMART_CONTRACT_ADDRESS = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const EXPECTED_CHAIN_ID = 31337;

const LOCAL_HARDHAT_NETWORK = {
  chainId: "0x7a69", // 31337
  chainName: "Hardhat Localhost",
  rpcUrls: ["http://127.0.0.1:8545"],
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};

const MEDICAL_RECORD_STRUCT =
  "tuple(uint256 id,address patient,address doctor,string diagnosis,string treatment,uint256 timestamp,bool active)";

const SMART_CONTRACT_ABI = [
  "function getRole(address) view returns (uint8)",
  "function registerUser(address userAddress, uint8 userRole)",
  "function removeUser(address userAddress)",
  "function createRecord(address patient,string diagnosis,string treatment) returns (uint256)",
  "function updateRecord(uint256 id,string diagnosis,string treatment)",
  "function deleteRecord(uint256 id)",
  `function getMyRecords() view returns (${MEDICAL_RECORD_STRUCT}[])`,
];

const ROLE_NAMES = { 1: "Admin", 2: "Doctor", 3: "Patient" };

// helpers
const getElement = (elementId) => document.getElementById(elementId);

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));

const shortenAddress = (address) => address.slice(0, 6) + "…" + address.slice(-4);
const getErrorMessage = (error) => error.shortMessage || error.message || "An error occurred";
const formatDate = (timestampInSeconds) =>
  new Date(Number(timestampInSeconds) * 1000).toLocaleString("en-US");

// Client-Side Encryption (AES-GCM 256-bit) so medical records are never plaintext on-chain
async function deriveRecordKey(patientAddr, doctorAddr) {
  const material = new TextEncoder().encode(
    `MediChain-EHR-v1:${patientAddr.toLowerCase()}:${doctorAddr.toLowerCase()}`
  );
  const hash = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptField(patientAddr, doctorAddr, plainText) {
  const key = await deriveRecordKey(patientAddr, doctorAddr);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(String(plainText));
  const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  const combined = new Uint8Array(iv.length + cipherBuffer.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuffer), iv.length);
  return "ENC:v1:" + btoa(String.fromCharCode(...combined));
}

async function decryptField(patientAddr, doctorAddr, storedText) {
  const text = String(storedText ?? "");
  if (!text.startsWith("ENC:v1:")) return text; // Backward-compatible with legacy plaintext records
  try {
    const key = await deriveRecordKey(patientAddr, doctorAddr);
    const combined = Uint8Array.from(atob(text.slice(7)), (c) => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: combined.slice(0, 12) },
      key,
      combined.slice(12)
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return "[Encrypted Record - Unable to Decrypt]";
  }
}

// toast
function showToast(title, message, type = "info", duration = 4200) {
  const container = getElement("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  const icons = { success: "✓", error: "✕", info: "i" };

  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || "i"}</div>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      <div class="toast-desc">${escapeHtml(message)}</div>
    </div>
    <button class="toast-close" aria-label="Close">&times;</button>
  `;

  const removeToast = () => {
    toast.classList.add("toast-hide");
    setTimeout(() => toast.remove(), 250);
  };

  toast.querySelector(".toast-close").onclick = removeToast;
  container.appendChild(toast);

  if (duration > 0) setTimeout(removeToast, duration);
}

// api (uses HttpOnly PHP session cookie instead of hardcoded ADMIN_KEY)
async function callApi(httpMethod, walletAddress, requestBody, action = "") {
  const params = new URLSearchParams();
  if (walletAddress) params.set("wallet_address", walletAddress);
  if (action) params.set("action", action);
  const queryString = params.toString();
  const url = "api.php" + (queryString ? "?" + queryString : "");

  const response = await fetch(url, {
    method: httpMethod,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: requestBody ? JSON.stringify(requestBody) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

const getExtraInfo = (user) =>
  user.role === "Doctor"
    ? user.specialization || "-"
    : user.age !== null && user.age !== undefined ? user.age + " years" : "-";

// Stops a registration before any transaction is sent when the wallet already
// has a role, so an existing profile is never overwritten by a second sign-up.
async function assertWalletNotRegistered(walletAddress) {
  if (!ethers.isAddress(walletAddress)) throw new Error("That is not a valid wallet address.");
  const existingRole = Number(await smartContract.getRole(walletAddress));
  if (existingRole !== 0) {
    throw new Error(
      `This wallet is already registered as ${ROLE_NAMES[existingRole]}. ` +
      "Existing users can only be changed with Edit, or removed by the Admin first."
    );
  }
}

// state
let smartContract;
let activeWallet;
let activeRole;
let userList = [];
let doctorRecordList = [];
let editingRecordId = null;

// network
// Makes sure MetaMask is on the chain the contract was deployed to.
async function ensureCorrectNetwork() {
  const currentChainId = Number(await window.ethereum.request({ method: "eth_chainId" }));
  if (currentChainId === EXPECTED_CHAIN_ID) return;

  const expectedChainIdHex = "0x" + EXPECTED_CHAIN_ID.toString(16);
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: expectedChainIdHex }],
    });
  } catch (error) {
    // 4902 = MetaMask does not know this chain yet
    const canAddNetwork = error.code === 4902 && expectedChainIdHex === LOCAL_HARDHAT_NETWORK.chainId;
    if (!canAddNetwork) {
      throw new Error(`Wrong network (chain ID ${currentChainId}). Please switch MetaMask to chain ID ${EXPECTED_CHAIN_ID}.`);
    }
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [LOCAL_HARDHAT_NETWORK],
    });
  }
}

// login
getElement("btnConnect").onclick = async () => {
  getElement("loginError").textContent = "";
  try {
    if (!window.ethereum) throw new Error("MetaMask not found. Please install it first.");
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await ensureCorrectNetwork();

    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const connectedWallet = (await signer.getAddress()).toLowerCase();

    let contractCode;
    try {
      contractCode = await provider.getCode(SMART_CONTRACT_ADDRESS);
    } catch {
      throw new Error("Cannot reach the blockchain node. Is `npx hardhat node` running?");
    }
    if (contractCode === "0x") {
      throw new Error(
        `No contract found at ${shortenAddress(SMART_CONTRACT_ADDRESS)} on chain ID ${EXPECTED_CHAIN_ID}. ` +
        "Run `npm run deploy` (needed after every restart of the Hardhat node), then refresh with Ctrl+F5."
      );
    }

    smartContract = new ethers.Contract(SMART_CONTRACT_ADDRESS, SMART_CONTRACT_ABI, signer);
    activeRole = Number(await smartContract.getRole(connectedWallet));
    activeWallet = connectedWallet;
    if (activeRole === 0) {
      activeWallet = undefined;
      throw new Error(`Wallet ${shortenAddress(connectedWallet)} is not registered. Please contact the Admin.`);
    }

    // Establish authenticated HttpOnly PHP session
    await callApi(
      "POST",
      null,
      {
        wallet_address: activeWallet,
        contract_address: SMART_CONTRACT_ADDRESS,
        role: activeRole,
      },
      "login"
    );

    startApplication();
    showToast("Wallet Connected", `Signed in as ${ROLE_NAMES[activeRole]} (${shortenAddress(activeWallet)})`, "success");
  } catch (error) {
    activeWallet = undefined;
    const errMsg = getErrorMessage(error);
    getElement("loginError").textContent = errMsg;
    showToast("Authentication Failed", errMsg, "error");
  }
};

getElement("btnLogout").onclick = async () => {
  await callApi("POST", null, {}, "logout").catch(() => {});
  location.reload();
};

if (window.ethereum) {
  const reloadIfSignedIn = async () => {
    if (activeWallet) {
      await callApi("POST", null, {}, "logout").catch(() => {});
      location.reload();
    }
  };
  window.ethereum.on("accountsChanged", reloadIfSignedIn);
  window.ethereum.on("chainChanged", reloadIfSignedIn);
}

function startApplication() {
  getElement("login").classList.add("hidden");
  getElement("app").classList.remove("hidden");
  getElement("roleBadge").textContent = ROLE_NAMES[activeRole];
  getElement("shortWallet").textContent = shortenAddress(activeWallet);

  getElement("viewAdmin").classList.toggle("hidden", activeRole !== 1);
  getElement("viewDoctor").classList.toggle("hidden", activeRole !== 2);
  getElement("viewPatient").classList.toggle("hidden", activeRole !== 3);

  loadMyProfile();
  if (activeRole === 1) {
    getElement("inputRole").onchange();
    loadUserList();
  }
  if (activeRole === 2) loadDoctorPage();
  if (activeRole === 3) loadPatientPage();
}

// profile
async function loadMyProfile() {
  if (activeRole === 1) {
    getElement("profileBox").innerHTML =
      `<p class="muted">Administrator (contract deployer). Admins have no off-chain profile.</p>`;
    return;
  }
  try {
    const profile = await callApi("GET", activeWallet);
    getElement("profileBox").innerHTML = `
      <div class="profile">
        <div>
          <b>${escapeHtml(profile.full_name)}</b>
          <span class="muted">(${escapeHtml(profile.role)})</span>
          <div class="muted">
            ${escapeHtml(profile.phone_number) || "-"} · ${escapeHtml(getExtraInfo(profile))}
          </div>
        </div>
        <button class="btn-ghost" id="btnEditMyProfile">Edit</button>
      </div>`;

    getElement("btnEditMyProfile").onclick = () =>
      openProfileDialog(profile, {
        title: "Edit My Profile",
        onSaved: () => {
          loadMyProfile();
          showToast("Profile Updated", "Your personal details have been updated.", "success");
        },
      });
  } catch {
    getElement("profileBox").innerHTML =
      `<p class="muted">Profile has not been created in the database.</p>`;
  }
}

// profile dialog
let profileDialogState = null;

function openProfileDialog(user, { title, showExtraField = false, onSaved }) {
  const isDoctor = user.role === "Doctor";
  profileDialogState = { user, showExtraField, onSaved };

  getElement("profileDialogTitle").textContent = title;
  getElement("profileDialogWallet").textContent = user.wallet_address;
  getElement("profileFullName").value = user.full_name;
  getElement("profilePhoneNumber").value = user.phone_number || "";

  getElement("profileExtraGroup").classList.toggle("hidden", !showExtraField);
  getElement("profileSpecialization").classList.toggle("hidden", !isDoctor);
  getElement("profileAge").classList.toggle("hidden", isDoctor);
  getElement("profileExtraLabel").textContent = isDoctor ? "Medical Specialization" : "Patient Age (Years)";
  getElement("profileExtraLabel").htmlFor = isDoctor ? "profileSpecialization" : "profileAge";
  getElement("profileSpecialization").value = user.specialization || "";
  getElement("profileAge").value = user.age ?? "";

  getElement("profileDialogError").textContent = "";
  getElement("profileDialog").showModal();
  getElement("profileFullName").focus();
}

const closeProfileDialog = () => getElement("profileDialog").close();
getElement("btnCloseProfileDialog").onclick = closeProfileDialog;
getElement("btnCancelProfile").onclick = closeProfileDialog;
getElement("profileDialog").onclick = (event) => {
  if (event.target === event.currentTarget) closeProfileDialog();
};

getElement("formProfile").onsubmit = async (event) => {
  event.preventDefault();
  const { user, showExtraField, onSaved } = profileDialogState;
  const updateData = {
    full_name: getElement("profileFullName").value.trim(),
    phone_number: getElement("profilePhoneNumber").value.trim(),
  };
  if (!updateData.full_name) {
    getElement("profileDialogError").textContent = "Full name is required.";
    return;
  }
  if (showExtraField) {
    if (user.role === "Doctor") updateData.specialization = getElement("profileSpecialization").value.trim();
    else updateData.age = getElement("profileAge").value;
  }

  const saveButton = getElement("btnSaveProfile");
  saveButton.disabled = true;
  try {
    await callApi("PUT", user.wallet_address, updateData);
    closeProfileDialog();
    onSaved(updateData);
  } catch (error) {
    getElement("profileDialogError").textContent = error.message;
  }
  saveButton.disabled = false;
};

// admin
getElement("inputRole").onchange = () => {
  const isDoctor = getElement("inputRole").value === "2";
  getElement("inputSpecialization").classList.toggle("hidden", !isDoctor);
  getElement("inputAge").classList.toggle("hidden", isDoctor);
  getElement("labelExtra").textContent = isDoctor ? "Medical Specialization" : "Patient Age (Years)";
};

async function loadUserList() {
  try {
    userList = await callApi("GET");
    getElement("userTableBody").innerHTML = userList.length
      ? userList.map((user) => `
        <tr>
          <td><b>${escapeHtml(user.full_name)}</b></td>
          <td>${escapeHtml(user.role)}</td>
          <td class="mono">${shortenAddress(user.wallet_address)}</td>
          <td>${escapeHtml(user.phone_number) || "-"}</td>
          <td>${escapeHtml(getExtraInfo(user))}</td>
          <td class="act">
            <button class="btn-ghost" data-action="edit" data-wallet="${escapeHtml(user.wallet_address)}">Edit</button>
            <button class="btn-danger" data-action="delete" data-wallet="${escapeHtml(user.wallet_address)}">Delete</button>
          </td>
        </tr>`).join("")
      : `<tr><td colspan="6" class="muted">No users yet</td></tr>`;
  } catch (error) {
    showToast("Database Error", error.message, "error");
  }
}

getElement("formUser").onsubmit = async (event) => {
  event.preventDefault();
  const submitButton = event.target.querySelector("button");
  submitButton.disabled = true;

  try {
    const newWalletAddress = getElement("inputWalletAddress").value.trim().toLowerCase();
    const roleCode = getElement("inputRole").value;
    const isDoctor = roleCode === "2";
    const fullName = getElement("inputFullName").value.trim();

    await assertWalletNotRegistered(newWalletAddress);
    showToast("Pending Confirmation", "Please confirm the transaction in MetaMask...", "info", 3000);

    const transaction = await smartContract.registerUser(newWalletAddress, Number(roleCode));
    await transaction.wait();

    await callApi("POST", null, {
      wallet_address: newWalletAddress,
      full_name: fullName,
      role: isDoctor ? "Doctor" : "Patient",
      phone_number: getElement("inputPhoneNumber").value,
      specialization: isDoctor ? getElement("inputSpecialization").value : "",
      age: isDoctor ? "" : getElement("inputAge").value,
    });

    event.target.reset();
    getElement("inputRole").onchange();
    showToast("User Registered", `${fullName} has been registered as ${isDoctor ? "Doctor" : "Patient"}.`, "success");
    loadUserList();
  } catch (error) {
    showToast("Registration Failed", getErrorMessage(error), "error");
  }
  submitButton.disabled = false;
};

getElement("userTableBody").onclick = async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const user = userList.find((item) => item.wallet_address === button.dataset.wallet);

  if (button.dataset.action === "edit") {
    openProfileDialog(user, {
      title: `Edit ${user.role} Profile`,
      showExtraField: true,
      onSaved: (updateData) => {
        loadUserList();
        showToast("Profile Updated", `${updateData.full_name}'s data has been updated.`, "success");
      },
    });
  }

  if (button.dataset.action === "delete") {
    if (!confirm(`Delete ${user.full_name}?`)) return;
    try {
      showToast("Pending Confirmation", "Confirm user removal in MetaMask...", "info", 3000);
      const transaction = await smartContract.removeUser(user.wallet_address);
      await transaction.wait();
      await callApi("DELETE", user.wallet_address);
      loadUserList();
      showToast("User Removed", `${user.full_name} has been removed from the system.`, "success");
    } catch (error) {
      showToast("Removal Failed", getErrorMessage(error), "error");
    }
  }
};

// doctor
const findUserName = (walletAddress) =>
  userList.find((item) => item.wallet_address === walletAddress.toLowerCase())?.full_name
  || shortenAddress(walletAddress);

async function loadDoctorPage() {
  try {
    userList = await callApi("GET");
    const patientList = userList.filter((item) => item.role === "Patient");

    getElement("selectPatient").innerHTML =
      `<option value="">-- Select patient --</option>` +
      patientList.map((patient) =>
        `<option value="${escapeHtml(patient.wallet_address)}">${escapeHtml(patient.full_name)} (${shortenAddress(patient.wallet_address)})</option>`
      ).join("");

    const contractResult = await smartContract.getMyRecords();
    const rawRecords = [...contractResult].reverse();

    doctorRecordList = await Promise.all(
      rawRecords.map(async (rec) => ({
        id: rec.id,
        patient: rec.patient,
        doctor: rec.doctor,
        diagnosis: await decryptField(rec.patient, rec.doctor, rec.diagnosis),
        treatment: await decryptField(rec.patient, rec.doctor, rec.treatment),
        timestamp: rec.timestamp,
        active: rec.active,
      }))
    );

    getElement("doctorRecords").innerHTML = doctorRecordList.length
      ? doctorRecordList.map((record) => `
        <div class="rec ${record.active ? "" : "off"}">
          <div class="rec-head">
            <div>
              <b>#${record.id} · ${escapeHtml(findUserName(record.patient))}</b>
              <div class="small">${formatDate(record.timestamp)} · ${record.active ? "Active" : "Deleted"}</div>
            </div>
            ${record.active ? `<div>
              <button class="btn-ghost" data-action="edit" data-id="${record.id}">Edit</button>
              <button class="btn-danger" data-action="delete" data-id="${record.id}">Delete</button>
            </div>` : ""}
          </div>
          <p><b>Diagnosis:</b> ${escapeHtml(record.diagnosis)}</p>
          <p><b>Treatment / Prescription:</b> ${escapeHtml(record.treatment)}</p>
        </div>`).join("")
      : `<p class="muted">No medical records yet</p>`;
  } catch (error) {
    showToast("Load Error", getErrorMessage(error), "error");
  }
}

// doctor register patient
getElement("formDoctorPatient").onsubmit = async (event) => {
  event.preventDefault();
  const submitButton = event.target.querySelector("button");
  submitButton.disabled = true;

  try {
    const patientWallet = getElement("docPatientWallet").value.trim().toLowerCase();
    const patientName = getElement("docPatientName").value.trim();

    await assertWalletNotRegistered(patientWallet);
    showToast("Pending Confirmation", "Please confirm patient registration in MetaMask...", "info", 3000);

    const transaction = await smartContract.registerUser(patientWallet, 3);
    await transaction.wait();

    await callApi("POST", null, {
      wallet_address: patientWallet,
      full_name: patientName,
      role: "Patient",
      phone_number: getElement("docPatientPhone").value,
      specialization: "",
      age: getElement("docPatientAge").value,
    });

    event.target.reset();
    showToast("Patient Registered", `${patientName} is now registered and selectable below.`, "success");
    await loadDoctorPage();
  } catch (error) {
    showToast("Registration Failed", getErrorMessage(error), "error");
  }
  submitButton.disabled = false;
};

// doctor records
function resetRecordForm() {
  editingRecordId = null;
  getElement("formRecord").reset();
  getElement("selectPatient").disabled = false;
  getElement("selectPatient").required = true;
  getElement("recordFormTitle").textContent = "Create New Medical Record";
  getElement("btnSaveRecord").textContent = "Save to Blockchain";
  getElement("btnCancelEdit").classList.add("hidden");
}
getElement("btnCancelEdit").onclick = resetRecordForm;

getElement("formRecord").onsubmit = async (event) => {
  event.preventDefault();
  const saveButton = getElement("btnSaveRecord");
  saveButton.disabled = true;

  try {
    const diagnosis = getElement("inputDiagnosis").value.trim();
    const treatment = getElement("inputTreatment").value.trim();
    const isEditing = Boolean(editingRecordId);

    const targetPatient = isEditing
      ? doctorRecordList.find((r) => Number(r.id) === editingRecordId)?.patient
      : getElement("selectPatient").value;

    const encryptedDiagnosis = await encryptField(targetPatient, activeWallet, diagnosis);
    const encryptedTreatment = await encryptField(targetPatient, activeWallet, treatment);

    showToast("Pending Confirmation", "Please confirm the medical record transaction in MetaMask...", "info", 3000);

    const transaction = isEditing
      ? await smartContract.updateRecord(editingRecordId, encryptedDiagnosis, encryptedTreatment)
      : await smartContract.createRecord(targetPatient, encryptedDiagnosis, encryptedTreatment);
    await transaction.wait();

    resetRecordForm();
    showToast(
      isEditing ? "Record Updated" : "Record Saved",
      isEditing ? "Medical record has been updated on-chain." : "New medical record permanently saved on the blockchain.",
      "success"
    );
    await loadDoctorPage();
  } catch (error) {
    showToast("Transaction Failed", getErrorMessage(error), "error");
  }
  saveButton.disabled = false;
};

getElement("doctorRecords").onclick = async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const record = doctorRecordList.find((item) => Number(item.id) === Number(button.dataset.id));

  if (button.dataset.action === "edit") {
    editingRecordId = Number(record.id);
    getElement("selectPatient").value = record.patient.toLowerCase();
    getElement("selectPatient").disabled = true;
    getElement("selectPatient").required = false;
    getElement("inputDiagnosis").value = record.diagnosis;
    getElement("inputTreatment").value = record.treatment;
    getElement("recordFormTitle").textContent = `Edit Medical Record #${record.id}`;
    getElement("btnSaveRecord").textContent = "Save Changes";
    getElement("btnCancelEdit").classList.remove("hidden");
    getElement("formRecord").scrollIntoView({ behavior: "smooth", block: "center" });
    showToast("Edit Mode", `Editing medical record #${record.id}`, "info", 2500);
  }

  if (button.dataset.action === "delete") {
    if (!confirm(`Delete medical record #${record.id}?`)) return;
    try {
      showToast("Pending Confirmation", "Confirm deletion in MetaMask...", "info", 3000);
      const transaction = await smartContract.deleteRecord(record.id);
      await transaction.wait();
      showToast("Record Deleted", `Medical record #${record.id} has been marked as deleted.`, "success");
      loadDoctorPage();
    } catch (error) {
      showToast("Deletion Failed", getErrorMessage(error), "error");
    }
  }
};

// patient
async function loadPatientPage() {
  try {
    userList = await callApi("GET");
    const contractResult = await smartContract.getMyRecords();
    const rawRecords = [...contractResult].reverse();

    const patientRecordList = await Promise.all(
      rawRecords.map(async (rec) => ({
        id: rec.id,
        patient: rec.patient,
        doctor: rec.doctor,
        diagnosis: await decryptField(rec.patient, rec.doctor, rec.diagnosis),
        treatment: await decryptField(rec.patient, rec.doctor, rec.treatment),
        timestamp: rec.timestamp,
      }))
    );

    getElement("patientRecords").innerHTML = patientRecordList.length
      ? patientRecordList.map((record) => {
          const doctor = userList.find(
            (item) => item.wallet_address === record.doctor.toLowerCase()
          );
          const doctorName = doctor
            ? `${doctor.full_name}${doctor.specialization ? " (" + doctor.specialization + ")" : ""}`
            : shortenAddress(record.doctor);
          return `
          <div class="rec">
            <b>Dr. ${escapeHtml(doctorName)}</b>
            <div class="small">${formatDate(record.timestamp)} · ID #${record.id}</div>
            <p><b>Diagnosis:</b> ${escapeHtml(record.diagnosis)}</p>
            <p><b>Treatment / Prescription:</b> ${escapeHtml(record.treatment)}</p>
          </div>`;
        }).join("")
      : `<p class="muted">No medical records yet</p>`;
  } catch (error) {
    getElement("patientMessage").textContent = getErrorMessage(error);
    showToast("Error Loading Records", getErrorMessage(error), "error");
  }
}