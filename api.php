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

// Replace with your actual contract deployer wallet address
define("ADMIN_WALLET", strtolower("0xALAMAT_WALLET_DEPLOYER_ANDA"));

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
$db_host = getenv("DB_HOST") ?: "localhost";
$db_user = getenv("DB_USER") ?: "medichain_app";
$db_pass = getenv("DB_PASS") ?: "PasswordKuat#2026!";
$db_name = getenv("DB_NAME") ?: "hospital_medical_records";

function send_response($data, $status_code = 200)
{
    http_response_code($status_code);
    echo json_encode($data);
    exit;
}

try {
    $connection = mysqli_connect($db_host, $db_user, $db_pass, $db_name);
    mysqli_set_charset($connection, "utf8mb4");
} catch (Throwable $exception) {
    error_log($exception->getMessage());
    send_response(["error" => "Database unavailable. Start MySQL and import database.sql."], 500);
}

$request_method = $_SERVER["REQUEST_METHOD"];
$wallet_address = strtolower(trim($_GET["wallet_address"] ?? ""));
$input_data     = json_decode(file_get_contents("php://input"), true) ?? [];
$action         = $_GET["action"] ?? "";

try {
    // Session Login
    if ($request_method === "POST" && $action === "login") {
        $login_wallet = strtolower(trim($input_data["wallet_address"] ?? ""));
        $login_role   = (int) ($input_data["role"] ?? 0);

        if (!preg_match('/^0x[a-f0-9]{40}$/', $login_wallet)) {
            send_response(["error" => "Invalid wallet address"], 400);
        }

        if ($login_wallet === ADMIN_WALLET && $login_role === 1) {
            session_regenerate_id(true);
            $_SESSION["wallet"] = $login_wallet;
            $_SESSION["role"]   = "Admin";
            send_response(["ok" => true]);
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
        send_response(["ok" => true]);
    }

    // Session Logout
    if ($request_method === "POST" && $action === "logout") {
        session_destroy();
        send_response(["ok" => true]);
    }

    // Require active session for ALL endpoints (GET, POST, PUT, DELETE)
    if (empty($_SESSION["wallet"]) || empty($_SESSION["role"])) {
        send_response(["error" => "Unauthorized: Please connect wallet first"], 401);
    }

    $caller_wallet = $_SESSION["wallet"];
    $caller_role   = $_SESSION["role"];

    // Read (with PII access filtering)
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
            $result = mysqli_query($connection,
                "SELECT wallet_address, full_name, role, specialization FROM users WHERE role = 'Doctor' ORDER BY full_name");
        }
        send_response(mysqli_fetch_all($result, MYSQLI_ASSOC));
    }

    // Create
    if ($request_method === "POST") {
        $wallet_address = strtolower(trim($input_data["wallet_address"] ?? ""));
        $full_name      = trim($input_data["full_name"] ?? "");
        $role           = $input_data["role"] ?? "";
        $phone_number   = trim($input_data["phone_number"] ?? "");
        $specialization = trim($input_data["specialization"] ?? "");
        $age = ($input_data["age"] ?? "") !== "" ? (int) $input_data["age"] : null;

        if ($caller_role === "Patient") {
            send_response(["error" => "Forbidden"], 403);
        }
        if ($caller_role === "Doctor" && $role !== "Patient") {
            send_response(["error" => "Doctors can only register patients"], 403);
        }

        if (!preg_match('/^0x[a-f0-9]{40}$/', $wallet_address) || $full_name === ""
            || !in_array($role, ["Doctor", "Patient"], true)) {
            send_response(["error" => "Invalid input"], 400);
        }

        $statement = mysqli_prepare($connection,
            "INSERT INTO users (wallet_address, full_name, role, phone_number, age, specialization)
             VALUES (?, ?, ?, ?, ?, ?)");
        mysqli_stmt_bind_param($statement, "ssssis",
            $wallet_address, $full_name, $role, $phone_number, $age, $specialization);
        mysqli_stmt_execute($statement);
        send_response(["ok" => true], 201);
    }

    // Update
    if ($request_method === "PUT") {
        if ($caller_role !== "Admin" && $caller_wallet !== $wallet_address) {
            send_response(["error" => "Forbidden: Cannot edit another user's profile"], 403);
        }

        $full_name      = trim($input_data["full_name"] ?? "");
        $phone_number   = trim($input_data["phone_number"] ?? "");
        $specialization = trim($input_data["specialization"] ?? "");
        $age = ($input_data["age"] ?? "") !== "" ? (int) $input_data["age"] : null;

        if ($wallet_address === "" || $full_name === "") {
            send_response(["error" => "Invalid input"], 400);
        }

        $statement = mysqli_prepare($connection,
            "UPDATE users SET full_name = ?, phone_number = ?, age = ?, specialization = ?
             WHERE wallet_address = ?");
        mysqli_stmt_bind_param($statement, "ssiss",
            $full_name, $phone_number, $age, $specialization, $wallet_address);
        mysqli_stmt_execute($statement);

        if (mysqli_stmt_affected_rows($statement) === 0) {
            send_response(["error" => "User not found or no changes made"], 404);
        }
        send_response(["ok" => true]);
    }

    // Delete
    if ($request_method === "DELETE") {
        if ($caller_role !== "Admin") {
            send_response(["error" => "Admin only"], 403);
        }

        $statement = mysqli_prepare($connection,
            "DELETE FROM users WHERE wallet_address = ?");
        mysqli_stmt_bind_param($statement, "s", $wallet_address);
        mysqli_stmt_execute($statement);

        if (mysqli_stmt_affected_rows($statement) === 0) {
            send_response(["error" => "User not found"], 404);
        }
        send_response(["ok" => true]);
    }

    send_response(["error" => "Method not supported"], 405);

} catch (Throwable $exception) {
    error_log($exception->getMessage());
    send_response(["error" => "Server error"], 500);
}
