<?php
header("Content-Type: application/json; charset=utf-8");

$admin_key = "a3f9c1e07b2d4856f0e1a9c3d5b7e2f4";

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

function send_response($data, $status_code = 200)
{
    http_response_code($status_code);
    echo json_encode($data);
    exit;
}

// Empty input becomes NULL, so "not filled in / not applicable" is always
// stored the same way (never a mix of NULL and empty string).
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

$request_method = $_SERVER["REQUEST_METHOD"];
$wallet_address = strtolower(trim($_GET["wallet_address"] ?? ""));
$input_data     = json_decode(file_get_contents("php://input"), true) ?? [];

// Write operations (POST, PUT, DELETE) require the admin key
if ($request_method !== "GET") {
    $sent_key = $_SERVER["HTTP_X_ADMIN_KEY"] ?? "";
    if (!hash_equals($admin_key, $sent_key)) {
        send_response(["error" => "Unauthorized"], 401);
    }
}

// Connect inside its own try so a stopped MySQL or a missing database still
// produces a JSON error the frontend can show (instead of a PHP error page).
try {
    $connection = mysqli_connect("localhost", "root", "", "hospital_medical_records");
    mysqli_set_charset($connection, "utf8mb4");
} catch (Throwable $exception) {
    error_log($exception->getMessage());
    send_response(["error" => "Database unavailable. Start MySQL in XAMPP and import database.sql."], 500);
}

try {
    //  Read
    if ($request_method === "GET") {
        if ($wallet_address !== "") {
            $statement = mysqli_prepare($connection,
                "SELECT * FROM users WHERE wallet_address = ?");
            mysqli_stmt_bind_param($statement, "s", $wallet_address);
            mysqli_stmt_execute($statement);
            $user = mysqli_fetch_assoc(mysqli_stmt_get_result($statement));
            $user ? send_response($user) : send_response(["error" => "Profile not found"], 404);
        }
        $result = mysqli_query($connection, "SELECT * FROM users ORDER BY full_name");
        send_response(mysqli_fetch_all($result, MYSQLI_ASSOC));
    }

    // Create
    if ($request_method === "POST") {
        $wallet_address = strtolower(trim($input_data["wallet_address"] ?? ""));
        $full_name      = trim($input_data["full_name"] ?? "");
        $role           = $input_data["role"] ?? "";
        $phone_number   = trim($input_data["phone_number"] ?? "");

        if (!preg_match('/^0x[a-f0-9]{40}$/', $wallet_address) || $full_name === ""
            || !in_array($role, ["Doctor", "Patient"], true)) {
            send_response(["error" => "Invalid input"], 400);
        }
        if (is_too_long($full_name, 100) || is_too_long($phone_number, 20)) {
            send_response(["error" => "Name (max 100) or phone number (max 20) is too long"], 400);
        }

        // Role-specific columns: a Doctor has a specialization and no age,
        // a Patient has an age and no specialization. The other one is NULL.
        $is_doctor      = $role === "Doctor";
        $specialization = $is_doctor ? text_or_null($input_data["specialization"] ?? "") : null;
        $age            = $is_doctor ? null : int_or_null($input_data["age"] ?? "");

        // Upsert: the blockchain is the source of truth for who is registered.
        // If a profile row was left behind (e.g. the chain was reset, or an
        // earlier request failed half-way), re-registering must not fail.
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

    // update
    if ($request_method === "PUT") {
        $full_name      = trim($input_data["full_name"] ?? "");
        $phone_number   = trim($input_data["phone_number"] ?? "");

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

        // The role decides which column applies; a field that was not sent
        // keeps its current value.
        $is_doctor      = $existing["role"] === "Doctor";
        $specialization = !$is_doctor ? null
            : text_or_null(array_key_exists("specialization", $input_data)
                ? $input_data["specialization"] : $existing["specialization"]);
        $age            = $is_doctor ? null
            : int_or_null(array_key_exists("age", $input_data)
                ? $input_data["age"] : $existing["age"]);

        $statement = mysqli_prepare($connection,
            "UPDATE users SET full_name = ?, phone_number = ?, age = ?, specialization = ?
             WHERE wallet_address = ?");
        mysqli_stmt_bind_param($statement, "ssiss",
            $full_name, $phone_number, $age, $specialization, $wallet_address);
        mysqli_stmt_execute($statement);
        send_response(["ok" => true]);
    }

    // Delete
    if ($request_method === "DELETE") {
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