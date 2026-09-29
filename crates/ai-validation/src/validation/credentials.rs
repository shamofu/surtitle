//! Credential import and explicitly requested provider metadata.
use super::arguments::Arguments;
use super::context::Context;
use super::{Result, ai_error};
use serde_json::{Value, json};
use std::path::Path;
use surtitle_ai::VertexDiscovery;

pub(super) fn import_key(root: &Path, mut args: Arguments) -> Result<Value> {
    let key_file = args.path("--key-file")?;
    args.finish()?;
    let context = Context::open(root)?;
    let metadata = context
        .vault
        .import_service_account(key_file)
        .map_err(ai_error)?;
    Ok(json!({"credential":metadata,"encryptedWith":"Windows DPAPI","networkRequests":0}))
}

pub(super) fn check_key(root: &Path, mut args: Arguments) -> Result<Value> {
    let id = args.string("--credential-id")?;
    args.finish()?;
    let context = Context::open(root)?;
    let metadata = context
        .vault
        .list()
        .map_err(ai_error)?
        .into_iter()
        .find(|key| key.id == id)
        .ok_or("Credential cannot be unlocked in this Windows account")?;
    Ok(
        json!({"credential":metadata,"unlocked":true,"oauthVerified":false,"vertexPermissionsVerified":false,"networkRequests":0}),
    )
}

pub(super) async fn list_models(root: &Path, mut args: Arguments) -> Result<Value> {
    let id = args.string("--credential-id")?;
    let location = args.string("--location")?;
    args.finish()?;
    let context = Context::open(root)?;
    let discovery = VertexDiscovery::new(context.vault).map_err(ai_error)?;
    let models = discovery
        .list_models(&id, &location)
        .await
        .map_err(ai_error)?;
    Ok(json!({"models":models,"location":location,"generationRequests":0}))
}

pub(super) async fn lookup_price(root: &Path, mut args: Arguments) -> Result<Value> {
    let id = args.string("--credential-id")?;
    let location = args.string("--location")?;
    let model = args.string("--model-id")?;
    args.finish()?;
    let context = Context::open(root)?;
    let discovery = VertexDiscovery::new(context.vault).map_err(ai_error)?;
    let pricing = discovery
        .pricing(&id, &model, &location)
        .await
        .map_err(ai_error)?;
    Ok(json!({"pricing":pricing,"modelId":model,"location":location,"generationRequests":0}))
}
