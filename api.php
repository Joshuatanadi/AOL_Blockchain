<?php
session_set_cookie_params([
    "lifetime" => 0,
    "httponly" => true,
    "secure"   => !empty($_SERVER["HTTPS"]),
    "samesite" => "Strict"
]);
session_start();

header("Content-Type: application/json; charset=utf-8");
header("X-Content-Type-Options: nosniff");
header("X-Frame-Options: DENY");
header("Referrer-Policy: no-referrer");

define("RPC_URL", getenv("RPC_URL") ?: "http://127.0.0.1:8545");
// Keep it in sync with SMART_CONTRACT_ADDRESS in app.js (npm run deploy prints it).
define("CONTRACT_ADDRESS", strtolower(getenv("CONTRACT_ADDRESS") ?: "0x5fbdb2315678afecb367f032d93f642f64180aa3"));
define("NONCE_TTL", 300);
const ROLE_NAMES = [1 => "Admin", 2 => "Doctor", 3 => "Patient"];

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

function login_message(string $wallet, string $nonce, int $issued_at): string
{
    return "MediChain login\nWallet: $wallet\nNonce: $nonce\nIssued: " . gmdate("c", $issued_at);
}

function abi_word(int $number): string
{
    return str_pad(dechex($number), 64, "0", STR_PAD_LEFT);
}

// pads hex data with zeros on the right up to a multiple of 32 bytes
function abi_pad(string $hex): string
{
    return str_pad($hex, (int) (ceil(strlen($hex) / 64) * 64), "0");
}

/**
 * Asks the smart contract (verifyLogin) whether $signature on $message was made by $wallet.
 * The contract does the signature math, so PHP needs no extra library.
 */
function verify_wallet_signature(string $message, string $signature, string $wallet): bool
{
    if (!preg_match('/^0x[a-fA-F0-9]{130}$/', $signature)) {
        return false;
    }

    $message_part   = abi_word(strlen($message)) . abi_pad(bin2hex($message));
    $signature_part = abi_word(65) . abi_pad(substr($signature, 2));

    // verifyLogin(address,string,bytes): 3 head words, then the string, then the bytes
    $call_data = "0xf1f173f9"
        . str_pad(substr($wallet, 2), 64, "0", STR_PAD_LEFT)
        . abi_word(96)
        . abi_word(96 + strlen($message_part) / 2)
        . $message_part
        . $signature_part;

    $payload = json_encode([
        "jsonrpc" => "2.0",
        "method"  => "eth_call",
        "params"  => [["to" => CONTRACT_ADDRESS, "data" => $call_data], "latest"],
        "id"      => 1
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
        send_response(["error" => "Blockchain RPC node unreachable (port 8545)"], 502);
    }
    $decoded = json_decode($raw, true);
    $result  = $decoded["result"] ?? "";
    return strlen($result) === 66 && substr($result, -1) === "1"; // returns bool true = ...0001
}

$request_method = $_SERVER["REQUEST_METHOD"];
$wallet_address = strtolower(trim($_GET["wallet_address"] ?? ""));
$input_data     = json_decode(file_get_contents("php://input"), true) ?? [];
$action         = $_GET["action"] ?? "";

try {
    $connection = mysqli_connect(getenv("DB_HOST") ?: "localhost", getenv("DB_USER") ?: "root", getenv("DB_PASS") ?: "", getenv("DB_NAME") ?: "hospital_medical_records");
    mysqli_set_charset($connection, "utf8mb4");
} catch (Throwable $exception) {
    error_log($exception->getMessage());
    send_response(["error" => "Database unavailable. Start MySQL in XAMPP and import database.sql."], 500);
}

try {
    // 1a. Challenge: the server hands out a one-time nonce that the wallet must sign
    if ($request_method === "POST" && $action === "nonce") {
        $nonce_wallet = strtolower(trim($input_data["wallet_address"] ?? ""));
        if (!preg_match('/^0x[a-f0-9]{40}$/', $nonce_wallet)) {
            send_response(["error" => "Invalid wallet address"], 400);
        }
        $_SESSION["login_wallet"] = $nonce_wallet;
        $_SESSION["login_nonce"]  = bin2hex(random_bytes(16));
        $_SESSION["login_at"]     = time();
        send_response(["message" => login_message($nonce_wallet, $_SESSION["login_nonce"], $_SESSION["login_at"])]);
    }

    // 1b. Login: the signature proves wallet ownership, the contract decides the role
    if ($request_method === "POST" && $action === "login") {
        $login_wallet = strtolower(trim($input_data["wallet_address"] ?? ""));
        $signature    = trim($input_data["signature"] ?? "");

        $nonce        = $_SESSION["login_nonce"]  ?? null;
        $nonce_wallet = $_SESSION["login_wallet"] ?? null;
        $issued_at    = (int) ($_SESSION["login_at"] ?? 0);
        unset($_SESSION["login_nonce"], $_SESSION["login_wallet"], $_SESSION["login_at"]); // single use

        if (!$nonce || $nonce_wallet !== $login_wallet || time() - $issued_at > NONCE_TTL) {
            send_response(["error" => "Login challenge missing or expired. Please try again."], 401);
        }
        if (!verify_wallet_signature(login_message($login_wallet, $nonce, $issued_at), $signature, $login_wallet)) {
            send_response(["error" => "Invalid signature"], 401);
        }

        $onchain_role = fetch_onchain_role(CONTRACT_ADDRESS, $login_wallet);
        if ($onchain_role === -1) {
            send_response(["error" => "Blockchain RPC node unreachable (port 8545)"], 502);
        }
        if (!isset(ROLE_NAMES[$onchain_role])) {
            send_response(["error" => "Wallet is not registered on the smart contract"], 403);
        }

        session_regenerate_id(true);
        $_SESSION["wallet"] = $login_wallet;
        $_SESSION["role"]   = ROLE_NAMES[$onchain_role];
        send_response(["ok" => true, "role" => ROLE_NAMES[$onchain_role]]);
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

    // Re-check the role on-chain on every request: a removed user loses access immediately
    $live_role = fetch_onchain_role(CONTRACT_ADDRESS, $caller_wallet);
    if ($live_role === -1) {
        send_response(["error" => "Blockchain RPC node unreachable"], 502);
    }
    if ((ROLE_NAMES[$live_role] ?? null) !== $caller_role) {
        session_destroy();
        send_response(["error" => "Session no longer valid: role changed on-chain"], 401);
    }

    // 4. Read: phone/age (PII) only go to the Admin and to the profile's owner
    if ($request_method === "GET") {
        $public_columns = "wallet_address, full_name, role, specialization";

        if ($wallet_address !== "") {
            if (!preg_match('/^0x[a-f0-9]{40}$/', $wallet_address)) {
                send_response(["error" => "Invalid wallet address"], 400);
            }
            $full_access = $caller_role === "Admin" || $wallet_address === $caller_wallet;
            $sql = "SELECT " . ($full_access ? "*" : $public_columns) . " FROM users WHERE wallet_address = ?";
            if ($caller_role === "Patient" && !$full_access) {
                $sql .= " AND role = 'Doctor'";
            }
            $statement = mysqli_prepare($connection, $sql);
            mysqli_stmt_bind_param($statement, "s", $wallet_address);
            mysqli_stmt_execute($statement);
            $user = mysqli_fetch_assoc(mysqli_stmt_get_result($statement));
            $user ? send_response($user) : send_response(["error" => "Profile not found"], 404);
        }

        if ($caller_role === "Admin") {
            $result = mysqli_query($connection, "SELECT * FROM users ORDER BY full_name");
        } elseif ($caller_role === "Doctor") {
            $result = mysqli_query($connection, "SELECT $public_columns FROM users ORDER BY full_name");
        } else {
            $result = mysqli_query($connection,
                "SELECT $public_columns FROM users WHERE role = 'Doctor' ORDER BY full_name");
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

        // The profile must match what the contract says; no ghost profiles, no role spoofing
        $chain_role = fetch_onchain_role(CONTRACT_ADDRESS, $wallet_address);
        if ($chain_role === -1) {
            send_response(["error" => "Blockchain RPC node unreachable"], 502);
        }
        if ($chain_role !== ($is_doctor ? 2 : 3)) {
            send_response(["error" => "Wallet is not registered on-chain with this role"], 409);
        }

        // Plain INSERT: an existing profile can no longer be overwritten through this endpoint
        $statement = mysqli_prepare($connection,
            "INSERT INTO users (wallet_address, full_name, role, phone_number, age, specialization)
             VALUES (?, ?, ?, ?, ?, ?)");
        mysqli_stmt_bind_param($statement, "ssssis",
            $wallet_address, $full_name, $role, $phone_number, $age, $specialization);
        try {
            mysqli_stmt_execute($statement);
        } catch (mysqli_sql_exception $duplicate) {
            if ((int) $duplicate->getCode() === 1062) {
                send_response(["error" => "Profile already exists. Use Edit instead."], 409);
            }
            throw $duplicate;
        }
        send_response(["ok" => true], 201);
    }

    // 6. Update
    if ($request_method === "PUT") {
        if ($caller_role !== "Admin" && $caller_wallet !== $wallet_address) {
            send_response(["error" => "Forbidden: Cannot edit another user's profile"], 403);
        }

        $full_name    = trim($input_data["full_name"] ?? "");
        $phone_number = trim($input_data["phone_number"] ?? "");

        if (!preg_match('/^0x[a-f0-9]{40}$/', $wallet_address) || $full_name === "") {
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

        if (!preg_match('/^0x[a-f0-9]{40}$/', $wallet_address)) {
            send_response(["error" => "Invalid wallet address"], 400);
        }
        $chain_role = fetch_onchain_role(CONTRACT_ADDRESS, $wallet_address);
        if ($chain_role === -1) {
            send_response(["error" => "Blockchain RPC node unreachable"], 502);
        }
        if ($chain_role !== 0) {
            send_response(["error" => "Remove the user on-chain first"], 409);
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