//! Passwords in the OS keychain (macOS Keychain, Secret Service on Linux).

use crate::error::{AppError, AppResult};
use uuid::Uuid;

const SERVICE: &str = "io.mongboard.connections";

fn entry(id: Uuid) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, &id.to_string()).map_err(|e| AppError::Keychain(e.to_string()))
}

pub fn set_password(id: Uuid, password: &str) -> AppResult<()> {
    entry(id)?.set_password(password).map_err(|e| AppError::Keychain(e.to_string()))
}

pub fn get_password(id: Uuid) -> AppResult<Option<String>> {
    match entry(id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}

pub fn delete_password(id: Uuid) -> AppResult<()> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}
