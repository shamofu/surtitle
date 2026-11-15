use crate::{models::valid_project_id, sha256_bytes, AiError, Result};
use gcp_auth::TokenProvider;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fmt, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CredentialMetadata {
    pub id: String,
    pub project_id: String,
    pub client_email: String,
    pub imported_at_ms: i64,
}

type AuthCache = Arc<Mutex<HashMap<String, (String, Arc<gcp_auth::CustomServiceAccount>)>>>;

#[derive(Clone)]
pub struct CredentialVault {
    directory: PathBuf,
    auth_cache: AuthCache,
}

impl fmt::Debug for CredentialVault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CredentialVault")
            .field("directory", &self.directory)
            .finish()
    }
}

impl CredentialVault {
    pub fn new(directory: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(directory.as_ref())?;
        Ok(Self {
            directory: directory.as_ref().canonicalize()?,
            auth_cache: Arc::default(),
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

    /// Read only the validated identity of a protected key; never expose its contents.
    pub fn metadata(&self, id: &str) -> Result<CredentialMetadata> {
        let (_, metadata) = self.load_json(id)?;
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
        let path = self.credential_path(id)?;
        self.evict_cached_account(id);
        fs::remove_file(path).map_err(|_| AiError::Credentials)
    }

    fn credential_path(&self, id: &str) -> Result<PathBuf> {
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(AiError::Credentials);
        }
        Ok(self.directory.join(format!("{id}.dpapi")))
    }

    fn evict_cached_account(&self, id: &str) {
        self.auth_cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(id);
    }

    pub(crate) fn service_account(
        &self,
        id: &str,
        expected_project_id: Option<&str>,
    ) -> Result<Arc<gcp_auth::CustomServiceAccount>> {
        let (key, metadata) = match self.load_json(id) {
            Ok(loaded) => loaded,
            Err(error) => {
                self.evict_cached_account(id);
                return Err(error);
            }
        };
        if let Some(expected) = expected_project_id {
            if metadata.project_id != expected {
                return Err(AiError::Credentials);
            }
        }
        let digest = sha256_bytes(key.as_bytes());
        if let Some((cached_digest, account)) = self
            .auth_cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get(id)
        {
            if *cached_digest == digest {
                drop(key);
                return Ok(Arc::clone(account));
            }
        }
        let account = Arc::new(
            gcp_auth::CustomServiceAccount::from_json(&key).map_err(|_| AiError::Credentials)?,
        );
        drop(key);
        let mut cache = self
            .auth_cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some((cached_digest, existing)) = cache.get(id) {
            if *cached_digest == digest {
                return Ok(Arc::clone(existing));
            }
        }
        cache.insert(id.to_owned(), (digest, Arc::clone(&account)));
        Ok(account)
    }

    pub(crate) async fn google_access_token(
        &self,
        id: &str,
        expected_project_id: Option<&str>,
    ) -> Result<Zeroizing<String>> {
        let auth = self.service_account(id, expected_project_id)?;
        match auth
            .token(&["https://www.googleapis.com/auth/cloud-platform"])
            .await
        {
            Ok(token) => Ok(Zeroizing::new(token.as_str().to_owned())),
            Err(_) => {
                self.evict_cached_account(id);
                Err(AiError::Credentials)
            }
        }
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
        assert!(vault.metadata("../secret").is_err());
    }
    #[cfg(windows)]
    #[test]
    fn metadata_reads_the_identity_from_the_protected_key() {
        let dir = tempfile::tempdir().unwrap();
        let vault = CredentialVault::new(dir.path()).unwrap();
        let json = serde_json::json!({
            "type":"service_account", "token_uri":"https://oauth2.googleapis.com/token",
            "project_id":"sample-project", "client_email":"user@sample-project.iam.gserviceaccount.com",
            "private_key_id":"test-only", "private_key":"synthetic test contents"
        }).to_string();
        let expected = validate_json(&json).unwrap();
        fs::write(
            vault.credential_path(&expected.id).unwrap(),
            protect(json.as_bytes()).unwrap(),
        )
        .unwrap();
        let observed = vault.metadata(&expected.id).unwrap();
        assert_eq!(observed.project_id, expected.project_id);
        assert_eq!(observed.client_email, expected.client_email);
        assert_eq!(observed.id, expected.id);
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

    #[cfg(windows)]
    fn ephemeral_rsa_pkcs8_pem() -> Zeroizing<String> {
        use base64::Engine;
        use windows_sys::Win32::Security::Cryptography::{
            BCryptCloseAlgorithmProvider, BCryptDestroyKey, BCryptExportKey, BCryptFinalizeKeyPair,
            BCryptGenerateKeyPair, BCryptOpenAlgorithmProvider, BCRYPT_RSAFULLPRIVATE_MAGIC,
            BCRYPT_RSAKEY_BLOB,
        };

        fn der_tlv(tag: u8, body: &[u8]) -> Vec<u8> {
            let mut out = vec![tag];
            if body.len() < 0x80 {
                out.push(body.len() as u8);
            } else if body.len() < 0x100 {
                out.extend_from_slice(&[0x81, body.len() as u8]);
            } else {
                out.extend_from_slice(&[0x82, (body.len() >> 8) as u8, body.len() as u8]);
            }
            out.extend_from_slice(body);
            out
        }

        fn der_int(bytes: &[u8]) -> Vec<u8> {
            let trimmed = match bytes.iter().position(|&b| b != 0) {
                Some(idx) => &bytes[idx..],
                None => &[0],
            };
            let mut body = Vec::with_capacity(trimmed.len() + 1);
            if trimmed[0] >= 0x80 {
                body.push(0);
            }
            body.extend_from_slice(trimmed);
            der_tlv(0x02, &body)
        }

        let alg_id: Vec<u16> = "RSA\0".encode_utf16().collect();
        let blob_type: Vec<u16> = "RSAFULLPRIVATEBLOB\0".encode_utf16().collect();
        let mut alg = std::ptr::null_mut();
        let mut key = std::ptr::null_mut();
        let blob = unsafe {
            assert_eq!(
                BCryptOpenAlgorithmProvider(&mut alg, alg_id.as_ptr(), std::ptr::null(), 0),
                0
            );
            assert_eq!(BCryptGenerateKeyPair(alg, &mut key, 2048, 0), 0);
            assert_eq!(BCryptFinalizeKeyPair(key, 0), 0);
            let mut size = 0u32;
            assert_eq!(
                BCryptExportKey(
                    key,
                    std::ptr::null_mut(),
                    blob_type.as_ptr(),
                    std::ptr::null_mut(),
                    0,
                    &mut size,
                    0,
                ),
                0
            );
            let mut buf = Zeroizing::new(vec![0u8; size as usize]);
            assert_eq!(
                BCryptExportKey(
                    key,
                    std::ptr::null_mut(),
                    blob_type.as_ptr(),
                    buf.as_mut_ptr(),
                    size,
                    &mut size,
                    0,
                ),
                0
            );
            BCryptDestroyKey(key);
            BCryptCloseAlgorithmProvider(alg, 0);
            buf
        };
        let header_size = std::mem::size_of::<BCRYPT_RSAKEY_BLOB>();
        let header: BCRYPT_RSAKEY_BLOB = unsafe { std::ptr::read_unaligned(blob.as_ptr().cast()) };
        assert_eq!(header.Magic, BCRYPT_RSAFULLPRIVATE_MAGIC);
        let mut offset = header_size;
        let mut next = |len: u32| -> &[u8] {
            let end = offset + len as usize;
            let slice = &blob[offset..end];
            offset = end;
            slice
        };
        let pub_exp = next(header.cbPublicExp);
        let modulus = next(header.cbModulus);
        let prime1 = next(header.cbPrime1);
        let prime2 = next(header.cbPrime2);
        let exp1 = next(header.cbPrime1);
        let exp2 = next(header.cbPrime2);
        let coeff = next(header.cbPrime1);
        let priv_exp = next(header.cbModulus);

        let mut rsa_body = Vec::new();
        rsa_body.extend_from_slice(&der_int(&[0]));
        for part in [
            modulus, pub_exp, priv_exp, prime1, prime2, exp1, exp2, coeff,
        ] {
            rsa_body.extend_from_slice(&der_int(part));
        }
        let rsa_der = der_tlv(0x30, &rsa_body);
        let alg_id_der = der_tlv(
            0x30,
            &[
                0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
            ],
        );
        let mut pkcs8_body = Vec::new();
        pkcs8_body.extend_from_slice(&der_int(&[0]));
        pkcs8_body.extend_from_slice(&alg_id_der);
        pkcs8_body.extend_from_slice(&der_tlv(0x04, &rsa_der));
        let pkcs8_der = Zeroizing::new(der_tlv(0x30, &pkcs8_body));
        let encoded = Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&*pkcs8_der));
        let wrapped = encoded
            .as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        Zeroizing::new(format!(
            "-----BEGIN {}-----\n{wrapped}\n-----END {}-----\n",
            "PRIVATE KEY", "PRIVATE KEY"
        ))
    }

    #[cfg(windows)]
    #[test]
    fn service_account_is_cached_per_credential_and_evicted_on_remove() {
        let dir = tempfile::tempdir().unwrap();
        let vault = CredentialVault::new(dir.path()).unwrap();
        let pem = ephemeral_rsa_pkcs8_pem();
        let json = Zeroizing::new(
            serde_json::json!({
                "type": "service_account",
                "token_uri": "https://oauth2.googleapis.com/token",
                "project_id": "sample-project",
                "client_email": "user@sample-project.iam.gserviceaccount.com",
                "private_key_id": "test-only",
                "private_key": &*pem
            })
            .to_string(),
        );
        let file = dir.path().join("ephemeral.json");
        fs::write(&file, json.as_bytes()).unwrap();
        let meta = vault.import_service_account(&file).unwrap();
        let first = vault
            .service_account(&meta.id, Some("sample-project"))
            .unwrap();
        let second = vault
            .service_account(&meta.id, Some("sample-project"))
            .unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert!(matches!(
            vault.service_account(&meta.id, Some("other-project")),
            Err(AiError::Credentials)
        ));
        vault.remove(&meta.id).unwrap();
        assert!(matches!(
            vault.service_account(&meta.id, Some("sample-project")),
            Err(AiError::Credentials)
        ));
    }
}

#[cfg(all(test, windows))]
mod openai_tests {
    use super::*;
    #[test]
    fn openai_keys_are_protected_separated_and_never_returned_in_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let vault = CredentialVault::new(dir.path()).unwrap();
        for key in ["", "sk-test\nAuthorization: bad", "Bearer sk-test", " x "] {
            assert!(vault.save_openai_key(key).is_err());
        }
        let key = "sk-test-openai-secret";
        let metadata = vault.save_openai_key(key).unwrap();
        assert!(!serde_json::to_string(&metadata).unwrap().contains(key));
        assert!(vault.metadata(&metadata.id).is_err());
        assert_eq!(&*vault.load_openai_key(&metadata.id).unwrap(), key);
        let bytes = fs::read(vault.openai_path(&metadata.id).unwrap()).unwrap();
        assert!(!bytes.windows(key.len()).any(|w| w == key.as_bytes()));
        vault.remove_openai_key(&metadata.id).unwrap();
        assert!(vault.openai_metadata(&metadata.id).is_err());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiCredentialMetadata {
    pub id: String,
    pub imported_at_ms: i64,
}
impl CredentialVault {
    fn openai_path(&self, id: &str) -> Result<PathBuf> {
        self.credential_path(id)?;
        Ok(self.directory.join(format!("openai-{id}.dpapi")))
    }
    pub fn save_openai_key(&self, key: &str) -> Result<OpenAiCredentialMetadata> {
        validate_openai_key(key)?;
        let id = openai_key_id(key);
        let encrypted = protect(key.as_bytes())?;
        let path = self.openai_path(&id)?;
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
        Ok(OpenAiCredentialMetadata {
            id,
            imported_at_ms: file_time(&path),
        })
    }
    pub fn openai_metadata(&self, id: &str) -> Result<OpenAiCredentialMetadata> {
        let _key = self.load_openai_key(id)?;
        Ok(OpenAiCredentialMetadata {
            id: id.into(),
            imported_at_ms: file_time(&self.openai_path(id)?),
        })
    }
    pub fn remove_openai_key(&self, id: &str) -> Result<()> {
        fs::remove_file(self.openai_path(id)?).map_err(|_| AiError::Credentials)
    }
    pub(crate) fn load_openai_key(&self, id: &str) -> Result<Zeroizing<String>> {
        let encrypted = fs::read(self.openai_path(id)?).map_err(|_| AiError::Credentials)?;
        if encrypted.len() > 16_384 {
            return Err(AiError::Credentials);
        }
        let plaintext = unprotect(&encrypted)?;
        let key = Zeroizing::new(
            String::from_utf8(plaintext.to_vec()).map_err(|_| AiError::Credentials)?,
        );
        validate_openai_key(&key)?;
        if openai_key_id(&key) != id {
            return Err(AiError::Credentials);
        }
        Ok(key)
    }
}
fn validate_openai_key(key: &str) -> Result<()> {
    if !(8..=4096).contains(&key.len())
        || !key.starts_with("sk-")
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(AiError::Credentials);
    }
    Ok(())
}

fn openai_key_id(key: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(b"openai\n");
    hash.update(key.as_bytes());
    format!("{:x}", hash.finalize())
}
