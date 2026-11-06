//! New preparations use this policy; approved jobs retain their frozen requests.
use surtitle_ai::{
    AudioChunkProfile, AudioPreparationReceipt, OpenAiAudioChunkingStrategy, VertexAudioPolicy,
};
use surtitle_core::{AiModelPreference, AiProvider, AppSettings};

pub(crate) const OPENAI_AUDIO_PROFILE: AudioChunkProfile = AudioChunkProfile::OpenAiFileSilence;
pub(crate) const OPENAI_CHUNKING_STRATEGY: Option<OpenAiAudioChunkingStrategy> = None;
pub(crate) const OPENAI_AUDIO_PROMPT: Option<&str> = None;

pub(crate) fn vertex_policy(mode: &str, boundary_repair: bool) -> Option<VertexAudioPolicy> {
    if boundary_repair {
        None
    } else if mode == "transcribe" {
        Some(VertexAudioPolicy::TranscribeFileV1)
    } else {
        Some(VertexAudioPolicy::AudioUnderstandingFileV1)
    }
}

pub(crate) fn profile(
    provider: AiProvider,
    boundary_repair: bool,
    mode: &str,
) -> AudioChunkProfile {
    match provider {
        AiProvider::Vertex if boundary_repair => AudioChunkProfile::Legacy,
        AiProvider::Vertex if mode == "transcribe" => {
            AudioChunkProfile::VertexTranscribeFileSilence
        }
        AiProvider::Vertex => AudioChunkProfile::VertexAudioFileSilence,
        // Explicit boundary repairs retain their separately approved short scope.
        AiProvider::Openai if boundary_repair => AudioChunkProfile::Quality30Seconds,
        AiProvider::Openai => OPENAI_AUDIO_PROFILE,
    }
}

pub(crate) fn selected_model(
    settings: &AppSettings,
    selected: Option<AiModelPreference>,
) -> anyhow::Result<AiModelPreference> {
    use anyhow::Context;
    let model = selected
        .or_else(|| {
            settings
                .models_for(settings.active_provider)
                .get("transcription")
                .cloned()
        })
        .context("Choose a transcription model in Settings")?;
    crate::application::models::execution_for(settings, "transcription", Some(model.clone()))?;
    Ok(model)
}

pub(crate) fn compatible(
    receipt: &AudioPreparationReceipt,
    settings: &AppSettings,
    boundary_repair: bool,
) -> bool {
    let provider = receipt
        .preparation_context
        .as_ref()
        .map_or(AiProvider::Vertex, |c| c.provider);
    let generation = receipt
        .preparation_context
        .as_ref()
        .map_or(0, |c| c.configuration_generation);
    provider == settings.active_provider
        && generation == settings.ai_configuration_generation
        && if provider == AiProvider::Vertex && !boundary_repair {
            matches!(
                receipt.chunk_profile,
                Some(
                    AudioChunkProfile::VertexTranscribeFileSilence
                        | AudioChunkProfile::VertexAudioFileSilence
                )
            )
        } else {
            receipt.chunk_profile.unwrap_or(AudioChunkProfile::Legacy)
                == profile(provider, boundary_repair, "transcribe")
        }
}

pub(crate) fn compatible_selected(
    receipt: &AudioPreparationReceipt,
    settings: &AppSettings,
    boundary_repair: bool,
    selected: &AiModelPreference,
) -> bool {
    compatible(receipt, settings, boundary_repair)
        && receipt.chunk_profile.unwrap_or(AudioChunkProfile::Legacy)
            == profile(
                settings.active_provider,
                boundary_repair,
                &selected.transcription_mode,
            )
        && (settings.active_provider != AiProvider::Vertex
            || receipt.prepared_job.execution.vertex_audio_policy
                == vertex_policy(&selected.transcription_mode, boundary_repair))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preparation_uses_dialog_mode_or_settings_default_independent_of_model_name() {
        let mut settings = AppSettings::default();
        let mut model = crate::application::models::preference_for(
            &crate::application::models::fixture_execution(),
            false,
        );
        model.model_id = "chosen-audio-model".into();
        settings
            .ai_models
            .insert("transcription".into(), model.clone());
        let fallback = selected_model(&settings, None).unwrap();
        assert_eq!(
            profile(
                settings.active_provider,
                false,
                &fallback.transcription_mode
            ),
            AudioChunkProfile::VertexAudioFileSilence
        );
        model.transcription_mode = "transcribe".into();
        let override_model = selected_model(&settings, Some(model)).unwrap();
        assert_eq!(
            profile(
                settings.active_provider,
                false,
                &override_model.transcription_mode
            ),
            AudioChunkProfile::VertexTranscribeFileSilence
        );
        assert_eq!(
            settings.ai_models["transcription"].transcription_mode,
            "subtitles"
        );
    }

    #[test]
    fn reviewed_repair_remains_one_complete_request_up_to_thirty_seconds() {
        for provider in [AiProvider::Vertex, AiProvider::Openai] {
            let options =
                surtitle_ai::ChunkOptions::for_profile(profile(provider, true, "transcribe"));
            let chunks = surtitle_ai::plan_chunks(0, 30_000 * 16, &[], options).unwrap();
            assert_eq!(chunks.len(), 1);
            assert_eq!(chunks[0].request_duration_ms(), 30_000);
        }
    }
}
