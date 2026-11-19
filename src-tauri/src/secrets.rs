//! Passwords in the OS keychain (macOS Keychain, Secret Service on Linux).

use crate::error::{AppError, AppResult};
use uuid::Uuid;

const SERVICE: &str = "io.mongoboard.connections";
/// Service name used before the app was renamed MongBoard → MongoBoard (v0.1.0).
const LEGACY_SERVICE: &str = "io.mongboard.connections";

fn entry(id: Uuid) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, &id.to_string()).map_err(|e| AppError::Keychain(e.to_string()))
}

/// Move a password saved by v0.1.0 to the new Keychain service name.
fn migrate_legacy(id: Uuid) -> AppResult<Option<String>> {
    let legacy = keyring::Entry::new(LEGACY_SERVICE, &id.to_string())
        .map_err(|e| AppError::Keychain(e.to_string()))?;
    match legacy.get_password() {
        Ok(password) => {
            set_password(id, &password)?;
            let _ = legacy.delete_credential();
            Ok(Some(password))
        }
        Err(_) => Ok(None),
    }
}

pub fn set_password(id: Uuid, password: &str) -> AppResult<()> {
    entry(id)?
        .set_password(password)
        .map_err(|e| AppError::Keychain(e.to_string()))
}

pub fn get_password(id: Uuid) -> AppResult<Option<String>> {
    match entry(id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => migrate_legacy(id),
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}

pub fn delete_password(id: Uuid) -> AppResult<()> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}
