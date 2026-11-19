use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),
    #[error("Parse error: {0}")]
    Parse(#[from] crate::shell_json::ParseError),
    #[error("{}", friendly_mongo(.0))]
    Mongo(#[from] mongodb::error::Error),
    #[error("Could not save settings: {0}")]
    Io(#[from] std::io::Error),
    #[error("Keychain: {0}")]
    Keychain(String),
    #[error("This connection is read-only")]
    ReadOnly,
    #[error("Not connected — open the connection first")]
    NotConnected,
    #[error("Unknown connection")]
    UnknownProfile,
}

impl AppError {
    pub fn msg(s: impl Into<String>) -> Self {
        AppError::Message(s.into())
    }
}

// Tauri sends command errors to the frontend as plain strings.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// Turn driver errors into something a person can act on.
fn friendly_mongo(e: &mongodb::error::Error) -> String {
    use mongodb::error::ErrorKind;
    let raw = e.to_string();
    let lower = raw.to_lowercase();
    match e.kind.as_ref() {
        ErrorKind::ServerSelection { .. } => {
            let hint = if lower.contains("connection refused") {
                "connection refused — is the server running and is the host/port right?"
            } else if lower.contains("timed out") || lower.contains("timeout") {
                "timed out — check your network/VPN and the cluster's IP access list"
            } else if lower.contains("dns")
                || lower.contains("resolve")
                || lower.contains("no record")
            {
                "the host name could not be resolved (DNS)"
            } else if lower.contains("tls") || lower.contains("certificate") {
                "the TLS handshake failed — check the tls/ssl options"
            } else if lower.contains("authentication") || lower.contains("auth") {
                "authentication failed — check the username, password and auth database"
            } else {
                "no server answered"
            };
            format!("Can't reach MongoDB: {hint}.\n\nDetails: {raw}")
        }
        ErrorKind::Authentication { message, .. } => format!("Authentication failed: {message}"),
        ErrorKind::DnsResolve { message, .. } => format!("DNS lookup failed: {message}"),
        ErrorKind::InvalidArgument { message, .. } => format!("Invalid setting: {message}"),
        ErrorKind::Command(c) => format!("{} (code {} {})", c.message, c.code, c.code_name),
        _ => raw,
    }
}
