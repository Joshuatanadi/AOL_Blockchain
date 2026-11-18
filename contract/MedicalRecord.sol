// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract MedicalRecord {
    enum Role { None, Admin, Doctor, Patient }

    struct Record {
        uint256 id;
        address patient;
        address doctor;
        string diagnosis;
        string treatment;
        uint256 timestamp;
        bool active;
    }

    mapping(address => Role) public roles;
    Record[] private records; // record id = array index + 1

    modifier onlyAdmin()  { require(roles[msg.sender] == Role.Admin,  "Admin only");  _; }
    modifier onlyDoctor() { require(roles[msg.sender] == Role.Doctor, "Doctor only"); _; }

    constructor() { roles[msg.sender] = Role.Admin; }

    // Admin : may register Doctors and Patients
    // Doctor: may only register Patients
    // A wallet that already has a role cannot be registered again (no silent
    // overwrite); the Admin has to remove it first to change its role.
    function registerUser(address userAddress, Role userRole) external {
        Role callerRole = roles[msg.sender];
        require(callerRole == Role.Admin || callerRole == Role.Doctor, "Admin or Doctor only");
        require(userRole == Role.Doctor || userRole == Role.Patient, "Role must be Doctor or Patient");
        require(callerRole == Role.Admin || userRole == Role.Patient, "Doctors can only register Patients");
        require(roles[userAddress] == Role.None, "Address already registered");
        roles[userAddress] = userRole;
    }

    function removeUser(address userAddress) external onlyAdmin {
        require(roles[userAddress] != Role.Admin, "Cannot remove an Admin");
        roles[userAddress] = Role.None;
    }

    function getRole(address userAddress) external view returns (Role) {
        return roles[userAddress];
    }

    // Doctor: Create / Update / Delete
    function createRecord(address patient, string calldata diagnosis, string calldata treatment)
        external onlyDoctor returns (uint256)
    {
        require(roles[patient] == Role.Patient, "Not a patient wallet");
        uint256 newId = records.length + 1;
        records.push(Record(newId, patient, msg.sender, diagnosis, treatment, block.timestamp, true));
        return newId;
    }

    function updateRecord(uint256 id, string calldata diagnosis, string calldata treatment)
        external onlyDoctor
    {
        Record storage record = _getRecord(id);
        require(record.doctor == msg.sender, "Not the creating doctor");
        require(record.active, "Record has been deleted");
        record.diagnosis = diagnosis;
        record.treatment = treatment;
    }

    function deleteRecord(uint256 id) external onlyDoctor { // soft delete
        Record storage record = _getRecord(id);
        require(record.doctor == msg.sender, "Not the creating doctor");
        require(record.active, "Record already deleted");
        record.active = false;
    }

    // Read
    // Doctor : all records they created (including deleted ones)
    // Patient: only their own active records
    function getMyRecords() external view returns (Record[] memory) {
        Role callerRole = roles[msg.sender];
        require(callerRole == Role.Doctor || callerRole == Role.Patient, "No access");

        uint256 total;
        for (uint256 i; i < records.length; i++) {
            if (_isVisible(records[i], callerRole)) total++;
        }
        Record[] memory result = new Record[](total);
        uint256 index;
        for (uint256 i; i < records.length; i++) {
            if (_isVisible(records[i], callerRole)) result[index++] = records[i];
        }
        return result;
    }

    function _isVisible(Record storage record, Role callerRole) internal view returns (bool) {
        if (callerRole == Role.Doctor) return record.doctor == msg.sender;
        return record.patient == msg.sender && record.active;
    }

    function _getRecord(uint256 id) internal view returns (Record storage) {
        require(id > 0 && id <= records.length, "Invalid record ID");
        return records[id - 1];
    }
}