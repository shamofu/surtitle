; SPDX-License-Identifier: GPL-3.0-or-later
; Standalone NSIS installer. Build inputs are supplied by scripts/package-app.mjs.
Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma
AllowSkipFiles off
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WordFunc.nsh"
!include "${__FILEDIR__}\..\native\windows-prerequisite.nsh"

!define PRODUCT "${APP_PRODUCT}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}"
Name "${PRODUCT}"
OutFile "${APP_OUTPUT}"
InstallDir "$LOCALAPPDATA\${PRODUCT}"
; Retain the registration written by the previous Tauri installer.
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "${PRODUCT}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "GPL-3.0-or-later"

!define MUI_ABORTWARNING
!define MUI_LANGDLL_REGISTRY_ROOT HKCU
!define MUI_LANGDLL_REGISTRY_KEY "${UNINSTALL_KEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "InstallerLanguage"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Surtitle requires Windows x64."
    SetErrorLevel 1633
    Abort
  ${EndIf}
  ; The legacy installer stores InstallLocation enclosed in double quotes.
  ; InstallDirRegKey also preserves NSIS's explicit /D override handling.
  StrCpy $0 $INSTDIR 1
  ${If} $0 == '$\"'
    StrCpy $INSTDIR $INSTDIR -1 1
  ${EndIf}
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "DisplayVersion"
  ${If} $0 != ""
    ${VersionCompare} $0 "${APP_VERSION}" $1
    ${If} $1 == 1
      MessageBox MB_OK|MB_ICONSTOP "A newer Surtitle version is installed."
      SetErrorLevel 1638
      Abort
    ${EndIf}
  ${EndIf}
  !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd

Section "Surtitle"
  SetShellVarContext current
  SetRegView 64
  !insertmacro NSIS_HOOK_PREINSTALL
  SetOutPath "$INSTDIR"
  SetOverwrite on
  ClearErrors
  File /oname=surtitle.exe "${APP_BINARY}"
  ${If} ${Errors}
    SetErrorLevel 1603
    Abort "Close Surtitle and run Setup again."
  ${EndIf}
  SetOutPath "$INSTDIR\native"
  File /r "${APP_RESOURCES}\native\*"
  SetOutPath "$INSTDIR\notices"
  File /r "${APP_RESOURCES}\notices\*"
  ${If} ${Errors}
    SetErrorLevel 1603
    Abort "The application resources could not be installed."
  ${EndIf}
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\surtitle.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" '$\"$INSTDIR$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\uninstall.exe$\" /S'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\surtitle.exe"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  !insertmacro MUI_UNGETLANGUAGE
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  ClearErrors
  Delete "$INSTDIR\surtitle.exe"
  ${If} ${Errors}
    SetErrorLevel 1603
    Abort "Close Surtitle and run the uninstaller again."
  ${EndIf}
  RMDir /r "$INSTDIR\native"
  RMDir /r "$INSTDIR\notices"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 == '$\"$INSTDIR$\"'
    Delete "$SMPROGRAMS\${PRODUCT}.lnk"
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ${EndIf}
  ; app.surtitle.desktop profiles and all downloaded tools/models are retained.
SectionEnd
