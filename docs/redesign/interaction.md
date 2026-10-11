# Interaction and visual direction

The video and the current sentence are the reading surface. A quiet neutral frame and one blue-green action color distinguish playback/learning from operational information. The native Segoe UI Variable / Yu Gothic UI stack avoids a network font prerequisite; captions use 24–28 px, normal controls 13–14 px. A compact 56 px app bar and 44 px media heading leave vertical space for video. Details open beside the video, never in an automatically growing row above it.

Light tokens: paper `#fafaf8`, surface `#ffffff`, ink `#24292f`, muted `#596774`, border `#d5dce0`, action `#176b78`. Dark tokens: background `#202328`, surface `#292e34`, ink `#f1f4f5`, muted `#afbbc4`, border `#46515b`, action `#83cedb`. Status colors communicate failure/waiting only; they are not decoration.

The layout is a player with a subtitle reading strip and optional companion, not a dashboard of status cards. Removing the old progress shelf, large caption allocation and geometric panel animation is intentional. Status updates never open a surface or resize the video. Auxiliary panels and primary controls have text labels. Existing-card and settings autosave show inline state without success toasts or confirmation. Explicit subtitle saves and credential replacement retain brief completion notifications; neither requires another click.

Settings and existing phrase edits use durable sessions independent of their mounted UI. Acknowledged drafts remain available after navigation/restart. Revision conflicts retain the previous input for explicit recovery instead of overwriting newer data. Incomplete fields do not block unrelated valid settings.

The automatic daily review reminder toast has been removed; the Review navigation remains the entry point. Background due-card timing no longer creates a full-provider minute clock. Unknown-charge accounting keeps its explanation and one explicit action, without a second acknowledgment checkbox.
