//! Saved connection profiles. Stored as JSON in the app's config folder; passwords live
//! in the OS keychain (see `secrets.rs`) and are never written to this file.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum EnvTag {
    Production,
    Qa,
    Dev,
    Local,
    #[default]
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    /// No credentials, or whatever the connection string itself carries.
    #[default]
    None,
    /// Username + password (SCRAM). Password is kept in the keychain.
    Password,
    /// MONGODB-AWS: IAM role / AWS credentials, optionally from a named AWS profile.
    Aws,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: Uuid,
    pub name: String,
    /// Connection string without username/password.
    pub uri: String,
    #[serde(default)]
    pub auth: AuthKind,
    #[serde(default)]
    pub username: Option<String>,
    /// authSource override (defaults to the URI's, then "admin").
    #[serde(default)]
    pub auth_source: Option<String>,
    /// SCRAM-SHA-1 / SCRAM-SHA-256; empty = let the server negotiate.
    #[serde(default)]
    pub auth_mechanism: Option<String>,
    /// Named profile from ~/.aws/config; empty = default AWS credential chain.
    #[serde(default)]
    pub aws_profile: Option<String>,
    #[serde(default)]
    pub tag: EnvTag,
    #[serde(default)]
    pub read_only: bool,
    /// Ask for confirmation before any write when tagged Production.
    #[serde(default = "default_true")]
    pub confirm_prod_writes: bool,
    #[serde(default)]
    pub default_database: Option<String>,
    #[serde(default)]
    pub last_used: Option<i64>,
}

fn default_true() -> bool {
    true
}

impl Profile {
    pub fn writes_allowed(&self) -> bool {
        !self.read_only
    }
}

pub struct ProfileStore {
    path: PathBuf,
    profiles: Mutex<Vec<Profile>>,
}

impl ProfileStore {
    pub fn load(path: PathBuf) -> Self {
        let profiles = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<Profile>>(&s).ok())
            .unwrap_or_default();
        Self { path, profiles: Mutex::new(profiles) }
    }

    pub fn list(&self) -> Vec<Profile> {
        self.profiles.lock().unwrap().clone()
    }

    pub fn get(&self, id: Uuid) -> Option<Profile> {
        self.profiles.lock().unwrap().iter().find(|p| p.id == id).cloned()
    }

    pub fn upsert(&self, profile: Profile) -> std::io::Result<()> {
        let mut list = self.profiles.lock().unwrap();
        match list.iter_mut().find(|p| p.id == profile.id) {
            Some(existing) => *existing = profile,
            None => list.push(profile),
        }
        self.persist(&list)
    }

    pub fn remove(&self, id: Uuid) -> std::io::Result<()> {
        let mut list = self.profiles.lock().unwrap();
        list.retain(|p| p.id != id);
        self.persist(&list)
    }

    pub fn touch(&self, id: Uuid, at_millis: i64) {
        let mut list = self.profiles.lock().unwrap();
        if let Some(p) = list.iter_mut().find(|p| p.id == id) {
            p.last_used = Some(at_millis);
        }
        let _ = self.persist(&list);
    }

    fn persist(&self, list: &[Profile]) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(list)?)?;
        std::fs::rename(tmp, &self.path)
    }
}

/// Credentials pulled out of a connection string.
#[derive(Debug, PartialEq, Eq)]
pub struct SplitUri {
    pub uri: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// Remove `user:pass@` from a MongoDB URI so the password never lands in the profile file.
/// Works for multi-host URIs (which are not valid URLs).
pub fn split_credentials(uri: &str) -> SplitUri {
    let trimmed = uri.trim();
    let Some(scheme_end) = trimmed.find("://") else {
        return SplitUri { uri: trimmed.to_string(), username: None, password: None };
    };
    let rest = &trimmed[scheme_end + 3..];
    let authority_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let Some(at) = authority.rfind('@') else {
        return SplitUri { uri: trimmed.to_string(), username: None, password: None };
    };
    let userinfo = &authority[..at];
    let (user, pass) = match userinfo.split_once(':') {
        Some((u, p)) => (u, Some(p)),
        None => (userinfo, None),
    };
    let clean = format!("{}{}{}", &trimmed[..scheme_end + 3], &authority[at + 1..], &rest[authority_end..]);
    SplitUri {
        uri: clean,
        username: Some(percent_decode(user)).filter(|s| !s.is_empty()),
        password: pass.map(percent_decode),
    }
}

pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_credentials_from_srv_uri() {
        let s = split_credentials("mongodb+srv://app%40ro:p%2Fss:w@cluster0.abc.mongodb.net/deliveries?retryWrites=true");
        assert_eq!(s.uri, "mongodb+srv://cluster0.abc.mongodb.net/deliveries?retryWrites=true");
        assert_eq!(s.username.as_deref(), Some("app@ro"));
        assert_eq!(s.password.as_deref(), Some("p/ss:w"));
    }

    #[test]
    fn handles_multi_host_and_no_credentials() {
        let s = split_credentials("mongodb://u:p@h1:27017,h2:27017/?replicaSet=rs0");
        assert_eq!(s.uri, "mongodb://h1:27017,h2:27017/?replicaSet=rs0");
        assert_eq!(s.username.as_deref(), Some("u"));
        let none = split_credentials("mongodb://localhost:27017");
        assert_eq!(none, SplitUri { uri: "mongodb://localhost:27017".into(), username: None, password: None });
        let user_only = split_credentials("mongodb://bob@localhost");
        assert_eq!(user_only.username.as_deref(), Some("bob"));
        assert_eq!(user_only.password, None);
    }

    #[test]
    fn store_round_trip() {
        let dir = std::env::temp_dir().join(format!("mongboard-test-{}", Uuid::new_v4()));
        let path = dir.join("connections.json");
        let store = ProfileStore::load(path.clone());
        let p = Profile {
            id: Uuid::new_v4(),
            name: "local".into(),
            uri: "mongodb://localhost".into(),
            auth: AuthKind::None,
            username: None,
            auth_source: None,
            auth_mechanism: None,
            aws_profile: None,
            tag: EnvTag::Local,
            read_only: false,
            confirm_prod_writes: true,
            default_database: None,
            last_used: None,
        };
        store.upsert(p.clone()).unwrap();
        let reloaded = ProfileStore::load(path);
        assert_eq!(reloaded.list(), vec![p.clone()]);
        reloaded.remove(p.id).unwrap();
        assert!(reloaded.list().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
