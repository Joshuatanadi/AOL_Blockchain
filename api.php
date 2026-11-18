<?php
session_set_cookie_params([
    "httponly" => true,
    "samesite" => "Strict"
]);
session_start();

header("Content-Type: application/json; charset=utf-8");
header("X-Content-Type-Options: nosniff");
header("X-Frame-Options: DENY");
header("Referrer-Policy: no-referrer");

define("RPC_URL", getenv("RPC_URL") ?: "http://127.0.0.1:8545");

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

function send_response($data, $status_code = 200)
{
    http_response_code($status_code);
    echo json_encode($data);
    exit;
}

function text_or_null($value)
{
    $value = trim((string) $value);
    return $value === "" ? null : $value;
}

function int_or_null($value)
{
    return ($value === null || $value === "") ? null : (int) $value;
}

function is_too_long($value, $max_length)
{
    return (function_exists("mb_strlen") ? mb_strlen($value) : strlen($value)) > $max_length;
}

/**
 * Verifikasi role langsung ke smart contract via JSON-RPC
 * Return: 0 = None, 1 = Admin, 2 = Doctor, 3 = Patient, -1 = RPC unreachable
 */
function fetch_onchain_role(string $contract_address, string $wallet_address): int
{
    $clean_wallet = substr($wallet_address, 2);
    $call_data    = "0x44276733" . str_pad($clean_wallet, 64, "0", STR_PAD_LEFT);

    $payload = json_encode([
        "jsonrpc" => "2.0",
        "method"  => "eth_call",
        "params"  => [
            [
                "to"   => $contract_address,
                "data" => $call_data
            ],
            "latest"
        ],
        "id" => 1
    ]);

    $context = stream_context_create([
        "http" => [
            "method"  => "POST",
            "header"  => "Content-Type: application/json\r\n",
            "content" => $payload,
            "timeout" => 5
        ]
    ]);

    $raw = @file_get_contents(RPC_URL, false, $context);
    if ($raw === false) {
        return -1;
    }

    $decoded = json_decode($raw, true);
    if (!isset($decoded["result"]) || $decoded["result"] === "0x") {
        return 0;
    }

    return (int) hexdec($decoded["result"]);
}

$request_method = $_SERVER["REQUEST_METHOD"];
$wallet_address = strtolower(trim($_GET["wallet_address"] ?? ""));
$input_data     = json_decode(file_get_contents("php://input"), true) ?? [];
$action         = $_GET["action"] ?? "";

try {
    $connection = mysqli_connect("localhost", "root", "", "hospital_medical_records");
    mysqli_set_charset($connection, "utf8mb4");
} catch (Throwable $exception) {
    error_log($exception->getMessage());
    send_response(["error" => "Database unavailable. Start MySQL in XAMPP and import database.sql."], 500);
}

try {
    // 1. Session Login
    if ($request_method === "POST" && $action === "login") {
        $login_wallet     = strtolower(trim($input_data["wallet_address"] ?? ""));
        $contract_address = strtolower(trim($input_data["contract_address"] ?? ""));
        $login_role       = (int) ($input_data["role"] ?? 0);

        if (!preg_match('/^0x[a-f0-9]{40}$/', $login_wallet)) {
            send_response(["error" => "Invalid wallet address"], 400);
        }

        if ($login_role === 1) {
            if (!preg_match('/^0x[a-f0-9]{40}$/', $contract_address)) {
                send_response(["error" => "Invalid smart contract address"], 400);
            }

            $onchain_role = fetch_onchain_role($contract_address, $login_wallet);
            if ($onchain_role === -1) {
                send_response(["error" => "Blockchain RPC node unreachable (port 8545)"], 502);
            }
            if ($onchain_role !== 1) {
                send_response(["error" => "Forbidden: Wallet is not the contract deployer/Admin"], 403);
            }

            session_regenerate_id(true);
            $_SESSION["wallet"] = $login_wallet;
            $_SESSION["role"]   = "Admin";
            send_response(["ok" => true, "role" => "Admin"]);
        }

        $stmt = mysqli_prepare($connection, "SELECT role FROM users WHERE wallet_address = ?");
        mysqli_stmt_bind_param($stmt, "s", $login_wallet);
        mysqli_stmt_execute($stmt);
        $db_user = mysqli_fetch_assoc(mysqli_stmt_get_result($stmt));

        if (!$db_user) {
            send_response(["error" => "Wallet not registered in database"], 403);
        }

        session_regenerate_id(true);
        $_SESSION["wallet"] = $login_wallet;
        $_SESSION["role"]   = $db_user["role"];
        send_response(["ok" => true, "role" => $db_user["role"]]);
    }

    // 2. Session Logout
    if ($request_method === "POST" && $action === "logout") {
        session_destroy();
        send_response(["ok" => true]);
    }

    // 3. Wajib punya session valid untuk semua operasi berikutnya
    if (empty($_SESSION["wallet"]) || empty($_SESSION["role"])) {
        send_response(["error" => "Unauthorized: Please connect wallet first"], 401);
    }

    $caller_wallet = $_SESSION["wallet"];
    $caller_role   = $_SESSION["role"];

    // 4. Read (dengan PII access filtering berdasarkan role)
    if ($request_method === "GET") {
        if ($wallet_address !== "") {
            if ($caller_role === "Patient" && $wallet_address !== $caller_wallet) {
                $statement = mysqli_prepare($connection,
                    "SELECT wallet_address, full_name, role, specialization FROM users WHERE wallet_address = ? AND role = 'Doctor'");
            } else {
                $statement = mysqli_prepare($connection,
                    "SELECT * FROM users WHERE wallet_address = ?");
            }
            mysqli_stmt_bind_param($statement, "s", $wallet_address);
            mysqli_stmt_execute($statement);
            $user = mysqli_fetch_assoc(mysqli_stmt_get_result($statement));
            $user ? send_response($user) : send_response(["error" => "Profile not found"], 404);
        }

        if ($caller_role === "Admin" || $caller_role === "Doctor") {
            $result = mysqli_query($connection, "SELECT * FROM users ORDER BY full_name");
        } else {
            // Patient hanya boleh melihat daftar Dokter (tanpa PII pasien lain)
            $result = mysqli_query($connection,
                "SELECT wallet_address, full_name, role, specialization FROM users WHERE role = 'Doctor' ORDER BY full_name");
        }
        send_response(mysqli_fetch_all($result, MYSQLI_ASSOC));
    }

    // 5. Create
    if ($request_method === "POST") {
        if ($caller_role === "Patient") {
            send_response(["error" => "Forbidden"], 403);
        }

        $wallet_address = strtolower(trim($input_data["wallet_address"] ?? ""));
        $full_name      = trim($input_data["full_name"] ?? "");
        $role           = $input_data["role"] ?? "";
        $phone_number   = trim($input_data["phone_number"] ?? "");

        if ($caller_role === "Doctor" && $role !== "Patient") {
            send_response(["error" => "Doctors can only register patients"], 403);
        }

        if (!preg_match('/^0x[a-f0-9]{40}$/', $wallet_address) || $full_name === ""
            || !in_array($role, ["Doctor", "Patient"], true)) {
            send_response(["error" => "Invalid input"], 400);
        }
        if (is_too_long($full_name, 100) || is_too_long($phone_number, 20)) {
            send_response(["error" => "Name (max 100) or phone number (max 20) is too long"], 400);
        }

        $is_doctor      = $role === "Doctor";
        $specialization = $is_doctor ? text_or_null($input_data["specialization"] ?? "") : null;
        $age            = $is_doctor ? null : int_or_null($input_data["age"] ?? "");

        if ($age !== null && ($age < 0 || $age > 150)) {
            send_response(["error" => "Invalid age range"], 400);
        }

        $statement = mysqli_prepare($connection,
            "INSERT INTO users (wallet_address, full_name, role, phone_number, age, specialization)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 full_name = VALUES(full_name), role = VALUES(role),
                 phone_number = VALUES(phone_number), age = VALUES(age),
                 specialization = VALUES(specialization)");
        mysqli_stmt_bind_param($statement, "ssssis",
            $wallet_address, $full_name, $role, $phone_number, $age, $specialization);
        mysqli_stmt_execute($statement);
        send_response(["ok" => true], 201);
    }

    // 6. Update
    if ($request_method === "PUT") {
        if ($caller_role !== "Admin" && $caller_wallet !== $wallet_address) {
            send_response(["error" => "Forbidden: Cannot edit another user's profile"], 403);
        }

        $full_name    = trim($input_data["full_name"] ?? "");
        $phone_number = trim($input_data["phone_number"] ?? "");

        if ($wallet_address === "" || $full_name === "") {
            send_response(["error" => "Invalid input"], 400);
        }
        if (is_too_long($full_name, 100) || is_too_long($phone_number, 20)) {
            send_response(["error" => "Name (max 100) or phone number (max 20) is too long"], 400);
        }

        $statement = mysqli_prepare($connection,
            "SELECT role, age, specialization FROM users WHERE wallet_address = ?");
        mysqli_stmt_bind_param($statement, "s", $wallet_address);
        mysqli_stmt_execute($statement);
        $existing = mysqli_fetch_assoc(mysqli_stmt_get_result($statement));
        if (!$existing) {
            send_response(["error" => "Profile not found"], 404);
        }

        $is_doctor      = $existing["role"] === "Doctor";
        $specialization = !$is_doctor ? null
            : text_or_null(array_key_exists("specialization", $input_data)
                ? $input_data["specialization"] : $existing["specialization"]);
        $age            = $is_doctor ? null
            : int_or_null(array_key_exists("age", $input_data)
                ? $input_data["age"] : $existing["age"]);

        if ($age !== null && ($age < 0 || $age > 150)) {
            send_response(["error" => "Invalid age range"], 400);
        }

        $statement = mysqli_prepare($connection,
            "UPDATE users SET full_name = ?, phone_number = ?, age = ?, specialization = ?
             WHERE wallet_address = ?");
        mysqli_stmt_bind_param($statement, "ssiss",
            $full_name, $phone_number, $age, $specialization, $wallet_address);
        mysqli_stmt_execute($statement);
        send_response(["ok" => true]);
    }

    // 7. Delete
    if ($request_method === "DELETE") {
        if ($caller_role !== "Admin") {
            send_response(["error" => "Admin only"], 403);
        }

        $statement = mysqli_prepare($connection,
            "DELETE FROM users WHERE wallet_address = ?");
        mysqli_stmt_bind_param($statement, "s", $wallet_address);
        mysqli_stmt_execute($statement);
        send_response(["ok" => true]);
    }

    send_response(["error" => "Method not supported"], 405);

} catch (Throwable $exception) {
    error_log($exception->getMessage());
    send_response(["error" => "Server error"], 500);
}