// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MedicalRecord {
    enum Role { None, Admin, Doctor, Patient }

    struct Record {
        uint256 id;
        address patient;
        address doctor;
        string data; // encrypted package (JSON), only ciphertext is stored
        uint256 timestamp;
        bool active;
    }

    address public admin;
    address public pendingAdmin;

    mapping(address => Role) public roles;
    mapping(address => bytes) public publicKeys; // encryption public key of each user

    Record[] private records; // record id = array index + 1
    mapping(address => uint256[]) private doctorRecordIds;
    mapping(address => uint256[]) private patientRecordIds;

    event UserRegistered(address indexed user, Role role, address indexed by);
    event UserRemoved(address indexed user, address indexed by);
    event PublicKeySet(address indexed user);
    event RecordCreated(uint256 indexed id, address indexed patient, address indexed doctor);
    event RecordUpdated(uint256 indexed id, address indexed doctor);
    event RecordDeleted(uint256 indexed id, address indexed doctor);
    event AdminTransferStarted(address indexed oldAdmin, address indexed newAdmin);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    modifier onlyAdmin()  { require(roles[msg.sender] == Role.Admin,  "Admin only");  _; }
    modifier onlyDoctor() { require(roles[msg.sender] == Role.Doctor, "Doctor only"); _; }

    constructor() {
        admin = msg.sender;
        roles[msg.sender] = Role.Admin;
    }

    // Admin: may register Doctors and Patients
    // Doctor: may only register Patients
    function registerUser(address userAddress, Role userRole) external {
        Role callerRole = roles[msg.sender];
        require(callerRole == Role.Admin || callerRole == Role.Doctor, "Admin or Doctor only");
        require(userAddress != address(0), "Invalid address");
        require(userRole == Role.Doctor || userRole == Role.Patient, "Role must be Doctor or Patient");
        require(callerRole == Role.Admin || userRole == Role.Patient, "Doctors can only register Patients");
        require(roles[userAddress] == Role.None, "Address already registered");
        roles[userAddress] = userRole;
        emit UserRegistered(userAddress, userRole, msg.sender);
    }

    function removeUser(address userAddress) external onlyAdmin {
        require(userAddress != admin, "Cannot remove the Admin");
        require(roles[userAddress] != Role.None, "User not registered");
        roles[userAddress] = Role.None;
        emit UserRemoved(userAddress, msg.sender);
    }

    function getRole(address userAddress) external view returns (Role) {
        return roles[userAddress];
    }

    // Every Doctor/Patient saves their own encryption public key once (65 bytes, uncompressed)
    function setPublicKey(bytes calldata key) external {
        require(roles[msg.sender] == Role.Doctor || roles[msg.sender] == Role.Patient, "Not allowed");
        require(key.length == 65, "Invalid public key");
        require(publicKeys[msg.sender].length == 0, "Key already set");
        publicKeys[msg.sender] = key;
        emit PublicKeySet(msg.sender);
    }

    // Admin change: old admin nominates, new wallet accepts (prevents typos locking the system)
    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Invalid address");
        require(roles[newAdmin] == Role.None, "Wallet already has a role");
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "Not the pending admin");
        require(roles[msg.sender] == Role.None, "Wallet already has a role");
        address oldAdmin = admin;
        roles[oldAdmin] = Role.None;
        roles[msg.sender] = Role.Admin;
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminTransferred(oldAdmin, msg.sender);
    }

    // Doctor: Create / Update / Delete
    function createRecord(address patient, string calldata data) external onlyDoctor returns (uint256) {
        require(roles[patient] == Role.Patient, "Not a patient wallet");
        require(publicKeys[msg.sender].length > 0, "Set your encryption key first");
        require(publicKeys[patient].length > 0, "Patient has not activated encryption");
        require(bytes(data).length > 0, "Empty data");

        uint256 newId = records.length + 1;
        records.push(Record(newId, patient, msg.sender, data, block.timestamp, true));
        doctorRecordIds[msg.sender].push(newId);
        patientRecordIds[patient].push(newId);
        emit RecordCreated(newId, patient, msg.sender);
        return newId;
    }

    function updateRecord(uint256 id, string calldata data) external onlyDoctor {
        Record storage record = _getRecord(id);
        require(record.doctor == msg.sender, "Not the creating doctor");
        require(record.active, "Record has been deleted");
        require(bytes(data).length > 0, "Empty data");
        record.data = data;
        emit RecordUpdated(id, msg.sender);
    }

    function deleteRecord(uint256 id) external onlyDoctor { // soft delete
        Record storage record = _getRecord(id);
        require(record.doctor == msg.sender, "Not the creating doctor");
        require(record.active, "Record already deleted");
        record.active = false;
        emit RecordDeleted(id, msg.sender);
    }

    // Doctor : all records they created (including deleted ones)
    // Patient: only their own active records
    function getMyRecords() external view returns (Record[] memory) {
        Role callerRole = roles[msg.sender];
        require(callerRole == Role.Doctor || callerRole == Role.Patient, "No access");

        if (callerRole == Role.Doctor) {
            uint256[] storage ids = doctorRecordIds[msg.sender];
            Record[] memory all = new Record[](ids.length);
            for (uint256 i = 0; i < ids.length; i++) {
                all[i] = records[ids[i] - 1];
            }
            return all;
        }

        uint256[] storage myIds = patientRecordIds[msg.sender];
        uint256 count = 0;
        for (uint256 i = 0; i < myIds.length; i++) {
            if (records[myIds[i] - 1].active) count++;
        }
        Record[] memory result = new Record[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < myIds.length; i++) {
            Record storage r = records[myIds[i] - 1];
            if (r.active) {
                result[index] = r;
                index++;
            }
        }
        return result;
    }

    // Used by api.php to check a MetaMask login signature (no PHP library needed).
    // Returns true only if `signature` on `message` was really made by `signer`.
    function verifyLogin(address signer, string calldata message, bytes calldata signature)
        external pure returns (bool)
    {
        if (signer == address(0) || signature.length != 65) return false;

        bytes32 hash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n", _toString(bytes(message).length), message
        ));
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return false;

        return ecrecover(hash, v, r, s) == signer; // ecrecover gives address(0) on failure, signer is never 0
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 temp = value; temp != 0; temp /= 10) digits++;
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }

    function _getRecord(uint256 id) internal view returns (Record storage) {
        require(id > 0 && id <= records.length, "Invalid record ID");
        return records[id - 1];
    }
}
