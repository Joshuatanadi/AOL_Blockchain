<?php
header("Content-Type: application/json; charset=utf-8");

$admin_key = "a3f9c1e07b2d4856f0e1a9c3d5b7e2f4";

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
$connection = mysqli_connect("localhost", "root", "", "hospital_medical_records");
mysqli_set_charset($connection, "utf8mb4");

function send_response($data, $status_code = 200)
{
    http_response_code($status_code);
    echo json_encode($data);
    exit;
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
        $specialization = trim($input_data["specialization"] ?? "");
        $age = ($input_data["age"] ?? "") !== "" ? (int) $input_data["age"] : null;

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

    // update
    if ($request_method === "PUT") {
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