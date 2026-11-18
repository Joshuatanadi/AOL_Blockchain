// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract MedicalRecord {
    enum Role { None, Admin, Doctor, Patient }

    struct Record {
        uint256 id;
        address patient;
        address doctor;
        string encryptedPayload; // AES-GCM encrypted JSON (diagnosis & treatment)
        uint256 timestamp;
        bool active;
    }

    mapping(address => Role) public roles;
    Record[] private records; // record id = array index + 1

    // Indexed IDs per user to prevent O(N) full-array scan DoS
    mapping(address => uint256[]) private doctorRecordIds;
    mapping(address => uint256[]) private patientRecordIds;

    event UserRegistered(address indexed user, Role role, address indexed registeredBy);
    event UserRemoved(address indexed user, address indexed removedBy);
    event RecordCreated(uint256 indexed id, address indexed patient, address indexed doctor);
    event RecordUpdated(uint256 indexed id, address indexed doctor);
    event RecordDeleted(uint256 indexed id, address indexed doctor);

    modifier onlyAdmin()  { require(roles[msg.sender] == Role.Admin,  "Admin only");  _; }
    modifier onlyDoctor() { require(roles[msg.sender] == Role.Doctor, "Doctor only"); _; }

    constructor() {
        roles[msg.sender] = Role.Admin;
    }

    // Admin can register Doctor or Patient; Doctor can only register Patient
    function registerUser(address userAddress, Role userRole) external {
        require(userAddress != address(0), "Invalid address");
        require(roles[userAddress] == Role.None, "User already registered");

        if (roles[msg.sender] == Role.Admin) {
            require(userRole == Role.Doctor || userRole == Role.Patient, "Role must be Doctor or Patient");
        } else if (roles[msg.sender] == Role.Doctor) {
            require(userRole == Role.Patient, "Doctors can only register patients");
        } else {
            revert("Unauthorized");
        }

        roles[userAddress] = userRole;
        emit UserRegistered(userAddress, userRole, msg.sender);
    }

    function removeUser(address userAddress) external onlyAdmin {
        require(roles[userAddress] != Role.Admin, "Cannot remove an Admin");
        require(roles[userAddress] != Role.None, "User not registered");
        roles[userAddress] = Role.None;
        emit UserRemoved(userAddress, msg.sender);
    }

    function getRole(address userAddress) external view returns (Role) {
        return roles[userAddress];
    }

    // Doctor: Create / Update / Delete
    function createRecord(address patient, string calldata encryptedPayload)
        external onlyDoctor returns (uint256)
    {
        require(roles[patient] == Role.Patient, "Not a patient wallet");
        require(bytes(encryptedPayload).length > 0, "Empty payload");

        uint256 newId = records.length + 1;
        records.push(Record(newId, patient, msg.sender, encryptedPayload, block.timestamp, true));

        doctorRecordIds[msg.sender].push(newId);
        patientRecordIds[patient].push(newId);

        emit RecordCreated(newId, patient, msg.sender);
        return newId;
    }

    function updateRecord(uint256 id, string calldata encryptedPayload)
        external onlyDoctor
    {
        Record storage record = _getRecord(id);
        require(record.doctor == msg.sender, "Not the creating doctor");
        require(record.active, "Record has been deleted");
        require(bytes(encryptedPayload).length > 0, "Empty payload");

        record.encryptedPayload = encryptedPayload;
        emit RecordUpdated(id, msg.sender);
    }

    function deleteRecord(uint256 id) external onlyDoctor {
        Record storage record = _getRecord(id);
        require(record.doctor == msg.sender, "Not the creating doctor");
        require(record.active, "Record already deleted");

        record.active = false;
        emit RecordDeleted(id, msg.sender);
    }

    // Read using per-user index mapping (prevents Gas Limit DoS)
    function getMyRecords() external view returns (Record[] memory) {
        Role callerRole = roles[msg.sender];
        require(callerRole == Role.Doctor || callerRole == Role.Patient, "No access");

        if (callerRole == Role.Doctor) {
            uint256[] storage ids = doctorRecordIds[msg.sender];
            Record[] memory result = new Record[](ids.length);
            for (uint256 i = 0; i < ids.length; i++) {
                result[i] = records[ids[i] - 1];
            }
            return result;
        } else {
            uint256[] storage ids = patientRecordIds[msg.sender];
            uint256 activeCount = 0;
            for (uint256 i = 0; i < ids.length; i++) {
                if (records[ids[i] - 1].active) activeCount++;
            }
            Record[] memory result = new Record[](activeCount);
            uint256 idx = 0;
            for (uint256 i = 0; i < ids.length; i++) {
                Record storage rec = records[ids[i] - 1];
                if (rec.active) result[idx++] = rec;
            }
            return result;
        }
    }

    function _getRecord(uint256 id) internal view returns (Record storage) {
        require(id > 0 && id <= records.length, "Invalid record ID");
        return records[id - 1];
    }
}
