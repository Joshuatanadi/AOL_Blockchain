// config
const SMART_CONTRACT_ADDRESS = "0x55cD697976056728bef4666E5D88E38cC67dEBC4";
const ADMIN_KEY = "a3f9c1e07b2d4856f0e1a9c3d5b7e2f4";

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

// api
async function callApi(httpMethod, walletAddress, requestBody) {
  const url = "api.php" + (walletAddress ? "?wallet_address=" + walletAddress : "");
  const response = await fetch(url, {
    method: httpMethod,
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
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

// state
let smartContract;
let activeWallet;
let activeRole;
let userList = [];
let doctorRecordList = [];
let editingRecordId = null;

// login
getElement("btnConnect").onclick = async () => {
  getElement("loginError").textContent = "";
  try {
    if (!window.ethereum) throw new Error("MetaMask not found. Please install it first.");
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const signer = await provider.getSigner();
    activeWallet = (await signer.getAddress()).toLowerCase();
    smartContract = new ethers.Contract(SMART_CONTRACT_ADDRESS, SMART_CONTRACT_ABI, signer);

    activeRole = Number(await smartContract.getRole(activeWallet));
    if (activeRole === 0) throw new Error("Wallet is not registered. Please contact the Admin.");
    
    startApplication();
    showToast("Wallet Connected", `Signed in as ${ROLE_NAMES[activeRole]} (${shortenAddress(activeWallet)})`, "success");
  } catch (error) {
    const errMsg = getErrorMessage(error);
    getElement("loginError").textContent = errMsg;
    showToast("Authentication Failed", errMsg, "error");
  }
};

getElement("btnLogout").onclick = () => location.reload();
if (window.ethereum) window.ethereum.on("accountsChanged", () => location.reload());

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

    getElement("btnEditMyProfile").onclick = async () => {
      const newFullName = prompt("Full name", profile.full_name);
      if (!newFullName) return;
      const newPhoneNumber = prompt("Phone number", profile.phone_number || "");
      try {
        await callApi("PUT", activeWallet, {
          full_name: newFullName,
          phone_number: newPhoneNumber ?? "",
          specialization: profile.specialization ?? "",
          age: profile.age ?? "",
        });
        loadMyProfile();
        showToast("Profile Updated", "Your personal details have been updated.", "success");
      } catch (error) {
        showToast("Update Failed", error.message, "error");
      }
    };
  } catch {
    getElement("profileBox").innerHTML =
      `<p class="muted">Profile has not been created in the database.</p>`;
  }
}

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
  showToast("Pending Confirmation", "Please confirm the transaction in MetaMask...", "info", 3000);

  try {
    const newWalletAddress = getElement("inputWalletAddress").value.trim().toLowerCase();
    const roleCode = getElement("inputRole").value;
    const isDoctor = roleCode === "2";
    const fullName = getElement("inputFullName").value;

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
    const newFullName = prompt("Full name", user.full_name);
    if (!newFullName) return;
    const newPhoneNumber = prompt("Phone number", user.phone_number || "");
    const updateData = { full_name: newFullName, phone_number: newPhoneNumber ?? "" };

    if (user.role === "Doctor") {
      updateData.specialization = prompt("Specialization", user.specialization || "") ?? "";
    } else {
      updateData.age = prompt("Age", user.age ?? "") ?? "";
    }
    try {
      await callApi("PUT", user.wallet_address, updateData);
      loadUserList();
      showToast("Profile Updated", `${newFullName}'s data has been updated.`, "success");
    } catch (error) {
      showToast("Update Failed", error.message, "error");
    }
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
    doctorRecordList = [...contractResult].reverse();

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
  showToast("Pending Confirmation", "Please confirm patient registration in MetaMask...", "info", 3000);

  try {
    const patientWallet = getElement("docPatientWallet").value.trim().toLowerCase();
    const patientName = getElement("docPatientName").value;

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
  showToast("Pending Confirmation", "Please confirm the medical record transaction in MetaMask...", "info", 3000);

  try {
    const diagnosis = getElement("inputDiagnosis").value;
    const treatment = getElement("inputTreatment").value;
    const isEditing = Boolean(editingRecordId);

    const transaction = isEditing
      ? await smartContract.updateRecord(editingRecordId, diagnosis, treatment)
      : await smartContract.createRecord(getElement("selectPatient").value, diagnosis, treatment);
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
    const patientRecordList = [...contractResult].reverse();

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