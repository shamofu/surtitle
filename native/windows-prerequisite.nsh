!include "LogicLib.nsh"
!include "x64.nsh"
!define SURTITLE_VC_HELPER "${__FILEDIR__}\vc-prerequisite.ps1"
!define SURTITLE_PLUGIN_DIR "${__FILEDIR__}\..\work\native-installer-tools\plugin"
!define SURTITLE_NATIVE_DIR "${__FILEDIR__}"

; Explicit Windows language IDs work before Tauri expands MUI_LANGUAGE.
LangString SurtitleVcConsent 1033 "Surtitle requires Microsoft Visual C++ x64 Runtime 14.44.35211 or newer.$\r$\n$\r$\nDownload it directly from Microsoft, verify its signature, and open Microsoft's installer now? Microsoft will ask you to accept its terms and may request administrator permission. No automatic restart will occur.$\r$\n$\r$\nIf offline, install the prerequisite separately and run Setup again."
LangString SurtitleVcConsent 1041 "Surtitleには Microsoft Visual C++ x64 Runtime 14.44.35211 以降が必要です。$\r$\n$\r$\nMicrosoftから直接ダウンロードし、署名を確認してMicrosoftのインストーラーを開きますか？ 利用規約への同意と管理者権限の確認が表示されます。自動では再起動しません。$\r$\n$\r$\nオフラインの場合は別途ランタイムを導入してから、セットアップを再実行してください。"
LangString SurtitleVcUnavailable 1033 "Microsoft runtime prerequisite is unavailable. Install the x64 runtime from https://aka.ms/vs/17/release/vc_redist.x64.exe and retry. Silent setup never installs this system prerequisite. Offline setup requires it to be installed already."
LangString SurtitleVcUnavailable 1041 "Microsoftランタイムを確認できません。https://aka.ms/vs/17/release/vc_redist.x64.exe からx64版を導入して再試行してください。サイレントセットアップではランタイムを導入しません。オフラインの場合は導入済みである必要があります。"
LangString SurtitleVcCancelled 1033 "Microsoft runtime installation was not approved. Setup has stopped."
LangString SurtitleVcCancelled 1041 "Microsoftランタイムの導入が承認されなかったため、セットアップを停止しました。"
LangString SurtitleVcFailure 1033 "Microsoft runtime installation or verification did not finish. If Microsoft requested a restart, restart Windows and run Setup again. Otherwise, install the x64 runtime separately and retry.$\r$\n$\r$\nDetails:"
LangString SurtitleVcFailure 1041 "Microsoftランタイムの導入または確認が完了しませんでした。再起動を求められた場合はWindowsを再起動し、セットアップを再実行してください。それ以外の場合はx64ランタイムを別途導入して再試行してください。$\r$\n$\r$\n詳細:"

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  File /oname=$PLUGINSDIR\surtitle-vc-prerequisite.ps1 "${SURTITLE_VC_HELPER}"
  StrCpy $R9 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$R9" +2 0
  StrCpy $R9 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::ExecToStack '"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\surtitle-vc-prerequisite.ps1" -CheckOnly'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    ${If} ${Silent}
      DetailPrint "$R1"
      SetErrorLevel 1603
      Abort "$(SurtitleVcUnavailable)"
    ${EndIf}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(SurtitleVcConsent)" IDYES surtitle_vc_install
    SetErrorLevel 1603
    Abort "$(SurtitleVcCancelled)"
    surtitle_vc_install:
    nsExec::ExecToStack '"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\surtitle-vc-prerequisite.ps1" -InstallWithConsent'
    Pop $R0
    Pop $R1
    ${If} $R0 != 0
      MessageBox MB_OK|MB_ICONSTOP "$(SurtitleVcFailure)$\r$\n$R1"
      SetErrorLevel 1603
      Abort "$(SurtitleVcUnavailable)"
    ${EndIf}
  ${EndIf}
!macroend
