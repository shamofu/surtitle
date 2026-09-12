# Transcript reference discovery, 2026-09-12

The five missing references in the frozen independent source selection remain missing. This investigation found exact downloadable publisher captions for two alternative English lectures and a better matched NICT corpus whose downloads currently redirect to a maintenance page. None is an approved replacement or an audio-verified reference. No audio was transcribed, no paid service was called, and no existing selection or approval was changed.

The frozen input is `work/transcribe-production-20260912/source-materials/source-manifest-independent.json`, SHA-256 `601cf815842624d2bc57ee70eacd884cd219433203a7e517590f71b011313107`. Retrieved metadata, captions, HTTP results, and their file hashes are retained separately under `work/transcribe-production-20260912/reference-discovery/`; `research-files.json` inventories those files. These ignored research materials are not application distribution inputs. See [reference preparation](transcribe-references.md) for the independent review requirements.

## Existing recordings

| Frozen recording and selected source interval | Primary-source check | Result |
| --- | --- | --- |
| Frank Schulenburg, Wiki Academy 2011, 120–360 seconds | [Commons recording](https://commons.wikimedia.org/wiki/File:Wiki_Academy_2011_-_Taking_Wikipedia_in_Higher_Education_to_the_next_level.ogv), CC BY 3.0, Wikimedia Israel; Commons `allpages` query of namespace 102 with the exact media filename prefix | No corresponding TimedText pages, including language suffixes. Retained response: `commons-schulenburg-timedtext-index.json`. |
| Yochai Benkler, Wikimania 2011 keynote, 120–600 seconds | [Commons recording](https://commons.wikimedia.org/wiki/File:Wikimania_2011_-_Keynote_speech_by_Yochai_Benkler.ogv), CC BY 3.0, Wikimedia Israel; same exact-filename TimedText query | No corresponding TimedText pages. Retained response: `commons-benkler-timedtext-index.json`. A conference abstract is not a transcript. |
| Steven Kraines, TogoTV 2010-05-25, 120–360 seconds | [DBCLS publisher page](https://togotv.dbcls.jp/20100525.html), DOI `10.7875/togotv.2010.056`, CC BY 4.0 | No downloadable transcript or timed reference located on the checked publisher page. Lecture description and slides cannot establish verbatim speech. |
| Keisuke Iida, TogoTV 2013-01-31, 120–600 seconds | [DBCLS publisher page](https://togotv.dbcls.jp/en/20130131.html), DOI `10.7875/togotv.2013.001`, CC BY 4.0 | No downloadable transcript or timed reference located on the checked page. The English page describes the Japanese lecture; it does not supply an English or Japanese transcript. |
| Amagasaki radio 2015-08-27, 120–600 seconds | [Pinned Koniwa metadata](https://github.com/koniwa/koniwa/blob/e2a6b4ff74e36805a7721342af210b4bf5b989e0/data/amagasaki/amagasaki__2015_08_27.json); sound and original text credited to Amagasaki City under CC BY 4.0 | `annotation` is empty. The complete pinned repository tree has no `source/amagasaki` transcript and no other substantial Amagasaki annotation file beyond the already selected 2011-04-20 pilot. |

Both Commons query responses are `{"batchcomplete":"","query":{"allpages":[]}}`, SHA-256 `38435ef9befbc6292b1c27ebc26430f4c80c44ff4e6b3ac2161a85b2e277bd58`. This is a dated check of those primary locations, not proof that a transcript cannot exist elsewhere. The obsolete municipal episode URL returns an error; the [current municipal open-data terms](https://www.city.amagasaki.hyogo.jp/opendata/1000081/1000084.html) retain the CC BY 4.0 policy.

## Koniwa annotation levels

The [pinned schema](https://github.com/koniwa/koniwa/blob/e2a6b4ff74e36805a7721342af210b4bf5b989e0/koniwa/schema.py) requires `text_level0` and `kana_level0`, and permits empty `text_level2` and `kana_level3`. Its validation requires the latter pair to be either both populated or both empty. It does not define a verbatim-selection or fallback rule. The [pinned README](https://github.com/koniwa/koniwa/blob/e2a6b4ff74e36805a7721342af210b4bf5b989e0/README.md) links this schema; no separate annotation manual was found in the complete pinned tree.

Retain every original level and `memo`. In particular, selecting level 0 alone can omit fillers present in level 2. Do not label a mechanical level-selection rule as an upstream-approved verbatim policy. The schema copy is `koniwa-schema.py`, SHA-256 `4b9e1aa4085b35081fa0a3a1f6d95e0495d809c7d914ae554a2092b56c12ee28`. Koniwa's own annotation contributions are CC0; the source sound/text licenses still apply.

## NICT alternatives: appropriate structure, unavailable archives

[NICT's official data index](https://www.nict.go.jp/data-provided/opendata.html) links SPREDS-P1 and SPREDS-D1. The [NICT-authored corpus paper](https://doi.org/10.11517/jsaislud.100.0_168) describes both continuous originals and segmented versions with transcriptions. Its descriptions establish the following distinction:

- **P1:** continuous presentations in English, Japanese, and other languages, with two topics and speakers of different genders. They use prepared scripts and have lower spontaneity. They are potential controlled presentation tests, not silently interchangeable with the current natural classroom/conference lectures. Select original unsegmented recordings, never concatenate the utterance files.
- **D1:** simulated business meetings performed by practitioners, using materials rather than reading a script; includes presentations and multi-person discussion. Original individual and mixed recordings plus transcription data are provided. This is a stronger candidate for independent Japanese dialogue once the exact duration, speakers, recording identity, and annotation coverage can be inspected.

[NICT's annual report, printed page 88](https://www.nict.go.jp/publication/shuppan/nenpou/pdf/nenpou_R5.pdf) confirms commercial-use-compatible CC BY 4.0 release for P1 and English D1. The [D1 release page](https://ast-astrec.nict.go.jp/en/release/SPREDS-D1/) describes Japanese/English CC BY 4.0 data, version 1.3, revised transcripts and segmentation, and `00README.txt` documentation. No independent word-boundary accuracy is established by these descriptions.

The following published archive addresses were recovered from a [pinned evaluation toolkit](https://github.com/ouktlab/asr-ja_evalkit/tree/20a13892e58c7283672c21fbd4a5db2eb4f87383). The toolkit is a location pointer; it is not the source of license authority.

| Archive candidate | Observed retrieval result |
| --- | --- |
| [P1 version 1.0](https://ast-astrec.nict.go.jp/release/SPREDS-P1/ver1.0/SPREDS-P1.ver1.0.tar.xz) | Redirects to maintenance HTML |
| [Japanese D1 version 1.3](https://ast-astrec.nict.go.jp/release/SPREDS-D1/ver1.3/SPREDS-D1.ver1.3.ja.tar.xz) | Redirects to maintenance HTML |
| [D2 version 1.1](https://ast-astrec.nict.go.jp/release/SPREDS-D2/ver1.1/SPREDS-D2.ver1.1.tar.xz) | Redirects to maintenance HTML; its included terms and recording lengths were not inspected |

`spreds-download-probes.json` records each URL, redirect, content type, range response, and first 64 bytes. All three return HTML without XZ magic; no archive was accepted or extracted. Consequently there are no verified candidate audio hashes, durations, or reference files from these archives yet. Cached page descriptions do not override the actual retrieval failure.

## Downloaded English publisher-caption alternatives

Two distinct MIT OpenCourseWare recordings have publisher-hosted VTT captions and direct media links. Caption files were retained; media was not downloaded and neither recording was listened to during this investigation.

| Recording | Downloaded reference and SHA-256 | Independent recording and voice |
| --- | --- | --- |
| [6.0001 Fall 2016, lecture 1: What is Computation?](https://ocw.mit.edu/courses/6-0001-introduction-to-computer-science-and-programming-in-python-fall-2016/resources/lecture-1-what-is-computation/) | [Publisher VTT](https://ocw.mit.edu/courses/6-0001-introduction-to-computer-science-and-programming-in-python-fall-2016/a746f6bc380f5e6d807ffff5f56cd877_nykOeWgQcHM.vtt), `mit-lecture1.vtt`, `404eb34eff454f97932952f677ce4bec0457488616dc5548ed8be81f70210a9f` | Ana Bell; original media filename `MIT6_0001F16_Lecture_01_300k.mp4` |
| [6.0001 Fall 2016, lecture 10: Understanding Program Efficiency, Part 1](https://ocw.mit.edu/courses/6-0001-introduction-to-computer-science-and-programming-in-python-fall-2016/resources/lecture-10-understanding-program-efficiency-part-1/) | [Publisher VTT](https://ocw.mit.edu/courses/6-0001-introduction-to-computer-science-and-programming-in-python-fall-2016/72291ca1d4a355abaa116a3156379efb_o9nW0uBqvEo.vtt), `mit-lecture10.vtt`, `4e78bf41e3bcf1116d3338896c0adf31d4da889bb36060449431b91f98d367f8` | Eric Grimson; original media filename `MIT6_0001F16_Lecture_10_300k.mp4` |

These are alternatives requiring an explicit source decision, not fully cleared defaults. [MIT's applicable terms](https://ocw.mit.edu/pages/privacy-and-terms-of-use/) specify **CC BY-NC-SA 4.0**, including noncommercial restrictions and additional discussion of AI training. The MIT software license does not apply to this course content. Do not bundle the material into GPL application assets or assume unrestricted commercial evaluation rights. Caption timestamps are cue times, not independently checked word boundaries; the checked pages do not establish the caption-production method. Both still require independent audio comparison and provenance review before quality scoring.

An [iBiology talk by Frank Schulenburg](https://www.ibiology.org/science-and-society/science-in-wikipedia/) also provides a transcript, but it is a different June 2011 recording, about eight minutes long, under CC BY-NC-ND 3.0 according to the publisher footer. It cannot be used as the reference for the frozen Wiki Academy recording. Its restrictions make it an inferior default alternative.

## Next usable decision

The existing eight audio selections remain frozen. Complete the three available upstream reference conversions separately, preserving their review flags. For the five missing references, either independently annotate the exact retained audio or create a separately versioned source proposal after obtaining a suitable annotated continuous recording. NICT D1 is the most promising Japanese dialogue replacement; NICT P1 changes the lecture test's spontaneity, and MIT changes the license constraints. Neither a maintenance page, lecture abstract, automatic transcript, nor stitched short readings can satisfy the missing reference requirement. No readiness or paid-approval gate was lifted by this investigation.
