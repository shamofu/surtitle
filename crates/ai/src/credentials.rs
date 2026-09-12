use crate::{models::valid_project_id, sha256_bytes, AiError, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CredentialMetadata {
    pub id: String,
    pub project_id: String,
    pub client_email: String,
    pub imported_at_ms: i64,
}

#[derive(Clone, Debug)]
pub struct CredentialVault {
    directory: PathBuf,
}

impl CredentialVault {
    pub fn new(directory: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(directory.as_ref())?;
        Ok(Self {
            directory: directory.as_ref().canonicalize()?,
        })
    }

    /// Native file-dialog path only. No plaintext key or access token is returned.
    pub fn import_service_account(&self, file: impl AsRef<Path>) -> Result<CredentialMetadata> {
        let mut input = fs::File::open(file).map_err(|_| AiError::Credentials)?;
        if input.metadata().map_err(|_| AiError::Credentials)?.len() > 65_536 {
            return Err(AiError::Credentials);
        }
        let mut plaintext = Zeroizing::new(String::new());
        std::io::Read::by_ref(&mut input)
            .take(65_537)
            .read_to_string(&mut plaintext)
            .map_err(|_| AiError::Credentials)?;
        if plaintext.len() > 65_536 {
            return Err(AiError::Credentials);
        }
        let mut metadata = validate_json(&plaintext)?;
        // Validate the PEM before persisting. This constructs an auth provider but does
        // not fetch a token and performs no paid API call.
        gcp_auth::CustomServiceAccount::from_json(&plaintext).map_err(|_| AiError::Credentials)?;
        let encrypted = protect(plaintext.as_bytes())?;
        let path = self.credential_path(&metadata.id)?;
        let temp = self.directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        output.write_all(&encrypted)?;
        output.sync_all()?;
        drop(output);
        if path.exists() {
            fs::remove_file(&temp)?;
        } else {
            fs::rename(&temp, &path)?;
        }
        metadata.imported_at_ms = file_time(&path);
        Ok(metadata)
    }

    pub fn list(&self) -> Result<Vec<CredentialMetadata>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            if entry.path().extension().is_some_and(|e| e == "dpapi") {
                let id = entry
                    .path()
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_owned();
                if let Ok((_, metadata)) = self.load_json(&id) {
                    out.push(metadata);
                }
            }
        }
        out.sort_by(|a, b| a.client_email.cmp(&b.client_email));
        Ok(out)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        fs::remove_file(self.credential_path(id)?).map_err(|_| AiError::Credentials)
    }

    fn credential_path(&self, id: &str) -> Result<PathBuf> {
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(AiError::Credentials);
        }
        Ok(self.directory.join(format!("{id}.dpapi")))
    }

    pub(crate) fn load_json(&self, id: &str) -> Result<(Zeroizing<String>, CredentialMetadata)> {
        let path = self.credential_path(id)?;
        let encrypted = fs::read(&path).map_err(|_| AiError::Credentials)?;
        if encrypted.len() > 100_000 {
            return Err(AiError::Credentials);
        }
        let plaintext = unprotect(&encrypted)?;
        let s = Zeroizing::new(
            String::from_utf8(plaintext.to_vec()).map_err(|_| AiError::Credentials)?,
        );
        let mut metadata = validate_json(&s)?;
        metadata.imported_at_ms = file_time(&path);
        if metadata.id != id {
            return Err(AiError::Credentials);
        }
        Ok((s, metadata))
    }
}

fn file_time(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn validate_json(s: &str) -> Result<CredentialMetadata> {
    let value: serde_json::Value = serde_json::from_str(s).map_err(|_| AiError::Credentials)?;
    let get = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .ok_or(AiError::Credentials)
    };
    if get("type")? != "service_account"
        || get("token_uri")? != "https://oauth2.googleapis.com/token"
    {
        return Err(AiError::Credentials);
    }
    // Do not allow credential JSON to choose another identity/token service or private
    // universe. The only outgoing endpoints are the Google OAuth and Vertex endpoints.
    if value
        .get("universe_domain")
        .and_then(|v| v.as_str())
        .is_some_and(|d| d != "googleapis.com")
    {
        return Err(AiError::Credentials);
    }
    let project_id = get("project_id")?.to_owned();
    let client_email = get("client_email")?.to_owned();
    if !valid_project_id(&project_id)
        || !client_email.ends_with(".iam.gserviceaccount.com")
        || client_email.len() > 254
        || get("private_key")?.len() > 20_000
    {
        return Err(AiError::Credentials);
    }
    let id = sha256_bytes(
        format!(
            "{}\n{}\n{}",
            project_id,
            client_email,
            get("private_key_id")?
        )
        .as_bytes(),
    );
    Ok(CredentialMetadata {
        id,
        project_id,
        client_email,
        imported_at_ms: 0,
    })
}

#[cfg(windows)]
fn protect(bytes: &[u8]) -> Result<Vec<u8>> {
    dpapi(bytes, false).map(|v| v.to_vec())
}
#[cfg(windows)]
fn unprotect(bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    dpapi(bytes, true)
}

#[cfg(windows)]
fn dpapi(bytes: &[u8], decrypt: bool) -> Result<Zeroizing<Vec<u8>>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let source = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|_| AiError::Credentials)?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let entropy = b"Surtitle native credentials v1";
    let context = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: All blobs remain alive for the call. DPAPI allocates output which is
    // copied, cleared when secret, then released with LocalFree. UI is forbidden.
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(
                &source,
                std::ptr::null_mut(),
                &context,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &source,
                std::ptr::null(),
                &context,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(AiError::Credentials);
    }
    let result = unsafe {
        let result = Zeroizing::new(
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec(),
        );
        if decrypt {
            use zeroize::Zeroize;
            std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize).zeroize();
        }
        LocalFree(output.pbData as *mut std::ffi::c_void);
        result
    };
    Ok(result)
}

#[cfg(not(windows))]
fn protect(_bytes: &[u8]) -> Result<Vec<u8>> {
    Err(AiError::Invalid(
        "Windows DPAPI is required; plaintext credential storage is not supported".into(),
    ))
}
#[cfg(not(windows))]
fn unprotect(_bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    Err(AiError::Credentials)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arbitrary_token_endpoints_and_external_credentials_are_rejected() {
        assert!(validate_json(
            r#"{"type":"external_account","token_uri":"https://evil.invalid/token"}"#
        )
        .is_err());
        let s = serde_json::json!({"type":"service_account","token_uri":"http://localhost/token","project_id":"sample-project","client_email":"user@sample-project.iam.gserviceaccount.com","private_key_id":"id","private_key":"secret"});
        assert!(validate_json(&s.to_string()).is_err());
    }
    #[test]
    fn path_traversal_cannot_select_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let vault = CredentialVault::new(dir.path()).unwrap();
        assert!(vault.credential_path("../secret").is_err());
    }
    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip_and_tamper_detection() {
        let data = b"local-secret-test";
        let encrypted = protect(data).unwrap();
        assert!(!encrypted.windows(data.len()).any(|w| w == data));
        assert_eq!(&*unprotect(&encrypted).unwrap(), data);
        let mut corrupt = encrypted;
        let mid = corrupt.len() / 2;
        corrupt[mid] ^= 1;
        assert!(unprotect(&corrupt).is_err());
    }
}
