//! Provider API keys. The desktop app and the CLI use the OS credential store (service
//! [`crate::APP_ID`], account `provider:{id}`); tests use an in-memory store.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::{Error, Result};

pub trait SecretStore: Send + Sync {
    /// The key of a provider, None when none is stored.
    fn get(&self, provider_id: &str) -> Result<Option<String>>;
    fn set(&self, provider_id: &str, secret: &str) -> Result<()>;
    /// Removing a key that does not exist is not an error.
    fn delete(&self, provider_id: &str) -> Result<()>;
}

/// macOS Keychain, Windows Credential Manager or the Linux Secret Service.
#[derive(Debug, Default)]
pub struct KeychainSecrets;

impl KeychainSecrets {
    pub const SERVICE: &'static str = crate::APP_ID;

    fn entry(provider_id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(Self::SERVICE, &format!("provider:{provider_id}")).map_err(keychain_err)
    }
}

fn keychain_err(e: keyring::Error) -> Error {
    Error::Keychain(format!("could not access the API key store: {e}"))
}

impl SecretStore for KeychainSecrets {
    fn get(&self, provider_id: &str) -> Result<Option<String>> {
        match Self::entry(provider_id)?.get_password() {
            Ok(k) => Ok(Some(k)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_err(e)),
        }
    }

    fn set(&self, provider_id: &str, secret: &str) -> Result<()> {
        Self::entry(provider_id)?.set_password(secret).map_err(keychain_err)
    }

    fn delete(&self, provider_id: &str) -> Result<()> {
        match Self::entry(provider_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_err(e)),
        }
    }
}

#[derive(Debug, Default)]
pub struct MemorySecrets(Mutex<HashMap<String, String>>);

impl MemorySecrets {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for MemorySecrets {
    fn get(&self, provider_id: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap_or_else(|e| e.into_inner()).get(provider_id).cloned())
    }

    fn set(&self, provider_id: &str, secret: &str) -> Result<()> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(provider_id.into(), secret.into());
        Ok(())
    }

    fn delete(&self, provider_id: &str) -> Result<()> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(provider_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrip() {
        let s = MemorySecrets::new();
        assert_eq!(s.get("openai").unwrap(), None);
        s.set("openai", "sk-1").unwrap();
        s.set("openai", "sk-2").unwrap();
        assert_eq!(s.get("openai").unwrap().as_deref(), Some("sk-2"));
        s.delete("openai").unwrap();
        s.delete("openai").unwrap();
        assert_eq!(s.get("openai").unwrap(), None);
    }
}
