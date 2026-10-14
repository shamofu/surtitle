// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

// CI-only launcher. The application itself never receives a debugging bypass.
public static class SurtitleWindowsStandardUser
{
    const uint TokenQuery = 0x0008;
    const uint MediumIntegrity = 0x2000;
    const uint CreateSuspended = 0x00000004;
    const uint ExtendedStartupInfoPresent = 0x00080000;
    const uint CreateNoWindow = 0x08000000;
    const uint Infinite = 0xffffffff;

    public static int Run(string application, string[] arguments, string directory)
    { return Run(application, arguments, directory, null); }

    public static int Run(string application, string[] arguments, string directory, string foregroundApplication)
    {
        if (!String.IsNullOrEmpty(foregroundApplication))
        {
            if (!Path.IsPathFullyQualified(foregroundApplication) || !File.Exists(foregroundApplication)
                || !String.Equals(Path.GetExtension(foregroundApplication), ".exe", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("ForegroundApplication must be an existing absolute .exe path.");
            foregroundApplication = Path.GetFullPath(foregroundApplication);
        }
        var commandLine = new StringBuilder(QuoteArgument(application));
        foreach (string argument in arguments)
            commandLine.Append(' ').Append(QuoteArgument(argument));
        if (commandLine.Length >= 32767)
            throw new ArgumentException("The application command line exceeds the Windows limit.");

        IntPtr currentToken = IntPtr.Zero, restrictedToken = IntPtr.Zero, saferLevel = IntPtr.Zero;
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, handleList = IntPtr.Zero;
        var standardHandles = new IntPtr[3];
        var process = new PROCESS_INFORMATION();
        bool attributesInitialized = false, completed = false;
        try
        {
            Check(OpenProcessToken(GetCurrentProcess(), TokenQuery | 0x0002 | 0x0001, out currentToken), "Open current process token");
            string user = TokenUser(currentToken);
            int session = TokenInteger(currentToken, 12); // TokenSessionId
            uint parentIntegrity = TokenIntegrity(currentToken);
            bool elevated = TokenInteger(currentToken, 20) != 0; // TokenElevation
            bool privilegedGroup = TokenHasPrivilegedGroups(currentToken);
            string unexpectedParentPrivilege;
            TokenPrivilegeSummary(currentToken, out unexpectedParentPrivilege);
            if (parentIntegrity < MediumIntegrity)
                throw new InvalidOperationException("The launcher cannot raise a low-integrity process to medium integrity.");

            bool restrict = elevated || privilegedGroup || parentIntegrity != MediumIntegrity || unexpectedParentPrivilege != null;
            if (restrict)
            {
                // NORMALUSER removes administrator privileges even when UAC is disabled.
                Check(SaferCreateLevel(2, 0x20000, 1, out saferLevel, IntPtr.Zero), "Create SAFER normal-user level");
                // Flags deliberately remain zero: MAKE_INERT would bypass policy checks.
                Check(SaferComputeTokenFromLevel(saferLevel, currentToken, out restrictedToken, 0, IntPtr.Zero), "Compute SAFER normal-user token");
                SetMediumIntegrity(restrictedToken);
                VerifyToken(restrictedToken, user, session, "SAFER candidate");
            }

            job = CreateJobObjectW(IntPtr.Zero, null);
            Check(job != IntPtr.Zero, "Create child job");
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)), "Set child job cleanup policy");

            for (int index = 0; index < standardHandles.Length; index++)
                standardHandles[index] = InheritableStandardHandle(-10 - index, index == 0);
            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            if (attributeSize == IntPtr.Zero) ThrowLastError("Size inherited handle list");
            attributes = Marshal.AllocHGlobal(attributeSize);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize), "Initialize inherited handle list");
            attributesInitialized = true;
            handleList = Marshal.AllocHGlobal(IntPtr.Size * standardHandles.Length);
            Marshal.Copy(standardHandles, 0, handleList, standardHandles.Length);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), handleList,
                new IntPtr(IntPtr.Size * standardHandles.Length), IntPtr.Zero, IntPtr.Zero), "Limit inherited handles");
            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(startup);
            startup.StartupInfo.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
            startup.StartupInfo.hStdInput = standardHandles[0];
            startup.StartupInfo.hStdOutput = standardHandles[1];
            startup.StartupInfo.hStdError = standardHandles[2];
            startup.lpAttributeList = attributes;
            uint flags = CreateSuspended | ExtendedStartupInfoPresent | CreateNoWindow;
            // A null environment inherits this wrapper's environment unchanged.
            bool created = restrict
                ? CreateProcessAsUserW(restrictedToken, application, commandLine, IntPtr.Zero, IntPtr.Zero,
                    true, flags, IntPtr.Zero, directory, ref startup, out process)
                : CreateProcessW(application, commandLine, IntPtr.Zero, IntPtr.Zero,
                    true, flags, IntPtr.Zero, directory, ref startup, out process);
            Check(created, "Create suspended standard-user process");
            Check(AssignProcessToJobObject(job, process.hProcess), "Assign child process to cleanup job");

            IntPtr childToken;
            Check(OpenProcessToken(process.hProcess, TokenQuery, out childToken), "Open child process token");
            string childSecurity;
            try { childSecurity = VerifyToken(childToken, user, session, "suspended child"); }
            finally { CloseHandle(childToken); }
            Console.Error.WriteLine("[restricted-medium] pid={0} {1}", process.dwProcessId, childSecurity);
            Check(ResumeThread(process.hThread) != Infinite, "Resume verified standard-user process");
            if (String.IsNullOrEmpty(foregroundApplication) || !RequiresForegroundHandoff(parentIntegrity))
            {
                if (!String.IsNullOrEmpty(foregroundApplication))
                    WriteForegroundReceipt(new { outcome = "skipped-medium-parent", application = foregroundApplication, parentIntegrity });
                Check(WaitForSingleObject(process.hProcess, Infinite) == 0, "Wait for standard-user process");
            }
            else
                WaitWithForegroundHandoff(process.hProcess, job, foregroundApplication, user, session, parentIntegrity);
            uint exitCode;
            Check(GetExitCodeProcess(process.hProcess, out exitCode), "Read child exit code");
            completed = true;
            return unchecked((int)exitCode);
        }
        finally
        {
            // The job handle is never inherited. Closing the wrapper kills descendants,
            // including when its main child has already exited successfully.
            if (!completed && process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 1);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            foreach (IntPtr handle in standardHandles)
                if (handle != IntPtr.Zero) CloseHandle(handle);
            if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);
            if (saferLevel != IntPtr.Zero) SaferCloseLevel(saferLevel);
            if (currentToken != IntPtr.Zero) CloseHandle(currentToken);
        }
    }

    public sealed class ForegroundIdentity
    {
        public uint processId { get; set; }
        public long creationTime { get; set; }
        public string executablePath { get; set; }
        public string userSid { get; set; }
        public int sessionId { get; set; }
        public uint integrity { get; set; }
        public bool inJob { get; set; }
        public long window { get; set; }
        public long root { get; set; }
        public long owner { get; set; }
        public bool visible { get; set; }
    }

    // Ordinary local runs retain the existing owned-caption activation path.
    // Only a high/system parent needs to hand its medium child the foreground.
    public static bool RequiresForegroundHandoff(uint parentIntegrity)
    { return parentIntegrity >= 0x3000; }

    // Also used by tests with synthetic identities; this performs no interop.
    public static void ValidateForegroundIdentity(ForegroundIdentity value, string application, string user, int session)
    {
        if (value == null || value.processId == 0 || value.creationTime <= 0 || !value.inJob)
            throw new InvalidOperationException("Foreground target must be a live process in the launcher's exact child job.");
        if (!String.Equals(value.executablePath, application, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Foreground target executable does not match the explicitly configured application.");
        if (value.userSid != user || value.sessionId != session || value.integrity != MediumIntegrity)
            throw new InvalidOperationException("Foreground target must preserve the caller's user and session at medium integrity.");
        if (value.window == 0 || value.root != value.window || value.owner != 0 || !value.visible)
            throw new InvalidOperationException("Foreground target must be a visible, unowned top-level window.");
    }

    sealed class ForegroundProcess : IDisposable
    {
        public IntPtr Handle;
        public uint Id;
        public long Creation;
        public readonly Stopwatch Startup = Stopwatch.StartNew();
        public readonly HashSet<long> Acknowledged = new HashSet<long>();
        public void Dispose() { if (Handle != IntPtr.Zero) CloseHandle(Handle); Handle = IntPtr.Zero; }
    }

    static void WaitWithForegroundHandoff(IntPtr child, IntPtr job, string application, string user, int session, uint parentIntegrity)
    {
        var targets = new Dictionary<uint, ForegroundProcess>();
        try
        {
            while (true)
            {
                uint waited = WaitForSingleObject(child, 100);
                if (waited == 0) return;
                Check(waited == 258, "Wait for standard-user process during foreground handoff");
                foreach (uint id in JobProcesses(job))
                {
                    if (targets.ContainsKey(id)) continue;
                    IntPtr handle = OpenProcess(0x00101000, false, id); // QUERY_LIMITED_INFORMATION | SYNCHRONIZE
                    if (handle == IntPtr.Zero) continue; // A job member can exit between snapshot and open.
                    try
                    {
                        if (WaitForSingleObject(handle, 0) != 258) continue;
                        Check(IsProcessInJob(handle, job, out bool inJob), "Check foreground process job membership");
                        if (!inJob || !String.Equals(ProcessImage(handle), application, StringComparison.OrdinalIgnoreCase)) continue;
                        Check(GetProcessTimes(handle, out long creation, out _, out _, out _), "Read foreground process creation time");
                        targets.Add(id, new ForegroundProcess { Handle = handle, Id = id, Creation = creation });
                        handle = IntPtr.Zero; // Held until this exact process exits, including throughout activation.
                    }
                    catch (Win32Exception) when (WaitForSingleObject(handle, 0) == 0) { }
                    finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
                }
                var exited = new List<uint>();
                foreach (ForegroundProcess target in targets.Values)
                {
                    uint state = WaitForSingleObject(target.Handle, 0);
                    if (state == 0) { exited.Add(target.Id); continue; }
                    Check(state == 258, "Check foreground process lifetime");
                    // Activation belongs to startup. Do not inspect or refocus
                    // later windows while the application is already in use.
                    if (target.Acknowledged.Count != 0) continue;
                    List<IntPtr> windows = ProcessRootWindows(target);
                    if (windows.Count > 1)
                        throw new InvalidOperationException("The configured foreground process has multiple visible unowned roots; refusing ambiguous activation.");
                    if (windows.Count == 0)
                    {
                        if (target.Acknowledged.Count == 0 && target.Startup.ElapsedMilliseconds >= 30000)
                            throw new TimeoutException("The configured foreground process did not create a visible unowned root within 30 seconds.");
                        continue;
                    }
                    IntPtr window = windows[0];
                    if (target.Acknowledged.Contains(window.ToInt64())) continue;
                    if (HandoffForeground(target, window, job, application, user, session, parentIntegrity))
                        target.Acknowledged.Add(window.ToInt64());
                }
                foreach (uint id in exited) { targets[id].Dispose(); targets.Remove(id); }
            }
        }
        catch (Exception error)
        {
            WriteForegroundReceipt(new { outcome = "failed", application, parentIntegrity, foreground = ForegroundSnapshot(),
                error = error.Message, win32Error = (error as Win32Exception)?.NativeErrorCode });
            throw;
        }
        finally { foreach (ForegroundProcess target in targets.Values) target.Dispose(); }
    }

    static IEnumerable<uint> JobProcesses(IntPtr job)
    {
        int capacity = 64;
        while (capacity <= 65536)
        {
            int length = checked(8 + capacity * IntPtr.Size);
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                if (!QueryInformationJobObject(job, 3, buffer, (uint)length, out _)) // JobObjectBasicProcessIdList
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error != 234) throw new Win32Exception(error, "Read the owned job's process list");
                    capacity *= 2;
                    continue;
                }
                int count = Marshal.ReadInt32(buffer, 4);
                if (count < 0 || count > capacity) throw new InvalidOperationException("Invalid owned job process count.");
                var ids = new List<uint>(count);
                for (int index = 0; index < count; index++)
                    ids.Add(checked((uint)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64()));
                return ids;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        throw new InvalidOperationException("The owned job exceeds the foreground monitor's process limit.");
    }

    static string ProcessImage(IntPtr handle)
    {
        var path = new StringBuilder(32768);
        uint length = (uint)path.Capacity;
        Check(QueryFullProcessImageNameW(handle, 0, path, ref length), "Read foreground process executable");
        return path.ToString();
    }

    static List<IntPtr> ProcessRootWindows(ForegroundProcess target)
    {
        var windows = new List<IntPtr>();
        // Enumerate only threads of a held, executable-validated job member.
        // No system-wide window search or foreign foreground mutation is needed.
        try
        {
            using (Process process = Process.GetProcessById(checked((int)target.Id)))
            {
                foreach (ProcessThread thread in process.Threads)
                {
                    using (thread)
                    {
                        EnumThreadWindows((uint)thread.Id, (window, unused) => {
                            GetWindowThreadProcessId(window, out uint id);
                            if (id == target.Id && IsWindowVisible(window) && GetAncestor(window, 2) == window
                                && GetWindow(window, 4) == IntPtr.Zero && !windows.Contains(window)) windows.Add(window);
                            return true;
                        }, IntPtr.Zero);
                    }
                }
            }
        }
        catch (InvalidOperationException) { if (WaitForSingleObject(target.Handle, 0) != 0) throw; }
        catch (ArgumentException) { if (WaitForSingleObject(target.Handle, 0) != 0) throw; }
        catch (Win32Exception) { if (WaitForSingleObject(target.Handle, 0) != 0) throw; }
        return windows;
    }

    static ForegroundIdentity ReadForegroundIdentity(ForegroundProcess target, IntPtr window, IntPtr job, string user, int session)
    {
        if (WaitForSingleObject(target.Handle, 0) != 258) throw new InvalidOperationException("Foreground target exited before acknowledgement.");
        GetWindowThreadProcessId(window, out uint id);
        if (id != target.Id) throw new InvalidOperationException("Foreground window process identity changed before acknowledgement.");
        Check(GetProcessTimes(target.Handle, out long creation, out _, out _, out _), "Recheck foreground process creation time");
        if (creation != target.Creation) throw new InvalidOperationException("Foreground process creation identity changed.");
        Check(IsProcessInJob(target.Handle, job, out bool inJob), "Recheck foreground process job membership");
        Check(OpenProcessToken(target.Handle, TokenQuery, out IntPtr token), "Read foreground process token");
        try
        {
            VerifyToken(token, user, session, "foreground target");
            return new ForegroundIdentity { processId = id, creationTime = creation, executablePath = ProcessImage(target.Handle),
                userSid = TokenUser(token), sessionId = TokenInteger(token, 12), integrity = TokenIntegrity(token), inJob = inJob,
                window = window.ToInt64(), root = GetAncestor(window, 2).ToInt64(), owner = GetWindow(window, 4).ToInt64(),
                visible = IsWindowVisible(window) };
        }
        finally { CloseHandle(token); }
    }

    static void ValidateForegroundWindow(ForegroundProcess target, IntPtr window)
    {
        if (WaitForSingleObject(target.Handle, 0) != 258 || !IsWindowVisible(window)
            || GetAncestor(window, 2) != window || GetWindow(window, 4) != IntPtr.Zero)
            throw new InvalidOperationException("Foreground target window or process changed before activation.");
        // Token/path reads can take time. Recheck HWND ownership last, immediately
        // before requesting activation, to reject a destroyed/reused HWND.
        GetWindowThreadProcessId(window, out uint id);
        if (id != target.Id) throw new InvalidOperationException("Foreground HWND ownership changed before activation.");
    }

    static bool HandoffForeground(ForegroundProcess target, IntPtr window, IntPtr job, string application, string user, int session, uint parentIntegrity)
    {
        var clock = Stopwatch.StartNew();
        object before = ForegroundSnapshot();
        ForegroundIdentity expected = null;
        int attempts = 0;
        bool accepted = false, acknowledged = false, exited = false;
        string failure = null;
        try
        {
            do
            {
                expected = ReadForegroundIdentity(target, window, job, user, session);
                ValidateForegroundIdentity(expected, application, user, session);
                ValidateForegroundWindow(target, window);
                if (GetForegroundWindow() == window) { acknowledged = true; return true; }
                if (!accepted)
                {
                    // This existing parent requests only its verified medium child.
                    // SetForegroundWindow still enforces Windows foreground policy:
                    // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setforegroundwindow
                    ValidateForegroundWindow(target, window);
                    accepted = SetForegroundWindow(window);
                    attempts++;
                }
                System.Threading.Thread.Sleep(50);
            } while (clock.ElapsedMilliseconds < 3000);
            throw new TimeoutException("The owned medium application did not acknowledge the launcher's foreground handoff within 3 seconds.");
        }
        catch (Exception) when (WaitForSingleObject(target.Handle, 0) == 0) { exited = true; return false; }
        catch (Exception error) { failure = error.Message; throw; }
        finally
        {
            WriteForegroundReceipt(new { outcome = acknowledged ? "acknowledged" : exited ? "target-exited" : "failed", application, parentIntegrity,
                expected, before, after = ForegroundSnapshot(), attempts, accepted, elapsedMs = clock.ElapsedMilliseconds, error = failure });
        }
    }

    static object ForegroundSnapshot()
    {
        IntPtr window = GetForegroundWindow();
        GetWindowThreadProcessId(window, out uint id);
        var name = new StringBuilder(256);
        GetClassNameW(window, name, name.Capacity);
        return new { window = window.ToInt64(), processId = id, className = name.ToString() };
    }

    static void WriteForegroundReceipt(object value)
    { Console.Error.WriteLine("[native-foreground] " + JsonSerializer.Serialize(value)); }

    // Windows CRT argv rules: quotes and backslashes must be escaped together.
    public static string QuoteArgument(string value)
    {
        if (value == null || value.IndexOf('\0') >= 0)
            throw new ArgumentException("Application arguments must be strings without NUL.");
        var quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            quoted.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes);
            quoted.Append(character);
            backslashes = 0;
        }
        return quoted.Append('\\', backslashes * 2).Append('"').ToString();
    }

    static string VerifyToken(IntPtr token, string user, int session, string phase)
    {
        int elevation = TokenInteger(token, 20), elevationType = TokenInteger(token, 18);
        uint integrity = TokenIntegrity(token);
        bool privilegedGroup = TokenHasPrivilegedGroups(token);
        // UAC-disabled administrators have no split token. SAFER can retain their
        // UAC elevation metadata even after removing administrative permissions.
        // Enforce effective integrity, groups and privileges; report UAC truthfully.
        if (integrity != MediumIntegrity || privilegedGroup)
            throw new InvalidOperationException(String.Format(
                "{0}: expected medium token with Administrators and Power Users absent or deny-only; elevation={1} elevationType={2} integrity={3} privilegedGroup={4}",
                phase, elevation, elevationType, integrity, privilegedGroup));
        if (TokenUser(token) != user || TokenInteger(token, 12) != session)
            throw new InvalidOperationException("The child token must preserve the caller's user and session.");
        string unexpectedPrivilege;
        string privileges = TokenPrivilegeSummary(token, out unexpectedPrivilege);
        if (unexpectedPrivilege != null)
            throw new InvalidOperationException(String.Format(
                "{0}: token retains a privilege outside the standard-user allowlist: {1}", phase, unexpectedPrivilege));
        return String.Format("elevated={0} integrity={1} admin=false elevationType={2} privileges={3} powerUser=false",
            (elevation != 0).ToString().ToLowerInvariant(), integrity, elevationType, privileges);
    }

    static string TokenPrivilegeSummary(IntPtr token, out string unexpectedPrivilege)
    {
        unexpectedPrivilege = null;
        IntPtr buffer = TokenInformation(token, 3); // TokenPrivileges
        try
        {
            uint count = unchecked((uint)Marshal.ReadInt32(buffer));
            int size = Marshal.SizeOf(typeof(LUID_AND_ATTRIBUTES));
            var names = new StringBuilder();
            for (uint index = 0; index < count; index++)
            {
                // LUID uses DWORD/LONG members, so TOKEN_PRIVILEGES entries align at 4.
                IntPtr entry = IntPtr.Add(buffer, sizeof(uint) + checked((int)index * size));
                var privilege = Marshal.PtrToStructure<LUID_AND_ATTRIBUTES>(entry);
                string name = PrivilegeName(privilege.Luid);
                // Check every privilege, including disabled ones: a process can
                // re-enable a privilege still present in its token.
                // Microsoft's filtered-token privilege set (Figure 5):
                // https://learn.microsoft.com/en-us/archive/msdn-magazine/2007/january/teach-your-apps-to-work-with-windows-vista-user-account-control
                switch (name)
                {
                    case "SeChangeNotifyPrivilege":
                    case "SeShutdownPrivilege":
                    case "SeUndockPrivilege":
                    case "SeIncreaseWorkingSetPrivilege":
                    case "SeTimeZonePrivilege":
                        break;
                    default:
                        if (unexpectedPrivilege == null)
                            unexpectedPrivilege = String.Format("{0} attributes=0x{1:X8}", name, privilege.Attributes);
                        break;
                }
                if (names.Length != 0) names.Append(',');
                names.Append(name);
            }
            return names.Length == 0 ? "none" : names.ToString();
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    static string PrivilegeName(LUID luid)
    {
        uint length = 0;
        LookupPrivilegeNameW(null, ref luid, null, ref length);
        if (length == 0) ThrowLastError("Size token privilege name");
        var name = new StringBuilder(checked((int)length + 1));
        length = (uint)name.Capacity;
        Check(LookupPrivilegeNameW(null, ref luid, name, ref length), "Read token privilege name");
        return name.ToString();
    }

    static IntPtr TokenInformation(IntPtr token, int informationClass)
    {
        uint length;
        GetTokenInformation(token, informationClass, IntPtr.Zero, 0, out length);
        if (length == 0) ThrowLastError("Size token information");
        IntPtr buffer = Marshal.AllocHGlobal(checked((int)length));
        if (!GetTokenInformation(token, informationClass, buffer, length, out length))
        {
            int error = Marshal.GetLastWin32Error();
            Marshal.FreeHGlobal(buffer);
            throw new Win32Exception(error, "Read token information");
        }
        return buffer;
    }

    static int TokenInteger(IntPtr token, int informationClass)
    {
        IntPtr buffer = TokenInformation(token, informationClass);
        try { return Marshal.ReadInt32(buffer); }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    static string TokenUser(IntPtr token)
    {
        IntPtr buffer = TokenInformation(token, 1);
        try { return SidString(Marshal.ReadIntPtr(buffer)); }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    static string SidString(IntPtr sid)
    {
        IntPtr text;
        Check(ConvertSidToStringSidW(sid, out text), "Read token SID");
        try { return Marshal.PtrToStringUni(text); }
        finally { LocalFree(text); }
    }

    static uint TokenIntegrity(IntPtr token)
    {
        IntPtr buffer = TokenInformation(token, 25);
        try
        {
            IntPtr sid = Marshal.ReadIntPtr(buffer);
            byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            if (count == 0) throw new InvalidOperationException("The token integrity SID has no authority.");
            return unchecked((uint)Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)count - 1)));
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    static bool TokenHasPrivilegedGroups(IntPtr token)
    {
        IntPtr buffer = TokenInformation(token, 2);
        try
        {
            uint count = unchecked((uint)Marshal.ReadInt32(buffer));
            int size = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
            for (uint index = 0; index < count; index++)
            {
                // TOKEN_GROUPS aligns its first SID_AND_ATTRIBUTES after the count.
                IntPtr entry = IntPtr.Add(buffer, IntPtr.Size + checked((int)index * size));
                var group = Marshal.PtrToStructure<SID_AND_ATTRIBUTES>(entry);
                // Disabled groups can be re-enabled; deny-only groups cannot.
                if ((group.Attributes & 0x10) == 0)
                {
                    string sid = SidString(group.Sid);
                    if (sid == "S-1-5-32-544" || sid == "S-1-5-32-547") return true;
                }
            }
            return false;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    static void SetMediumIntegrity(IntPtr token)
    {
        IntPtr sid;
        Check(ConvertStringSidToSidW("S-1-16-8192", out sid), "Create medium integrity SID");
        try
        {
            var label = new SID_AND_ATTRIBUTES { Sid = sid, Attributes = 0x20 };
            Check(SetTokenInformation(token, 25, ref label,
                checked((uint)Marshal.SizeOf(label) + GetLengthSid(sid))), "Set medium token integrity");
        }
        finally { LocalFree(sid); }
    }

    static IntPtr InheritableStandardHandle(int identifier, bool input)
    {
        IntPtr original = GetStdHandle(identifier);
        bool fallback = original == IntPtr.Zero || original == new IntPtr(-1);
        if (fallback)
        {
            original = CreateFileW("NUL", input ? 0x80000000u : 0x40000000u, 3,
                IntPtr.Zero, 3, 0, IntPtr.Zero);
            Check(original != new IntPtr(-1), "Open standard handle fallback");
        }
        try
        {
            IntPtr duplicate;
            Check(DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), out duplicate,
                0, true, 2), "Duplicate inherited standard handle");
            return duplicate;
        }
        finally { if (fallback) CloseHandle(original); }
    }

    static void Check(bool success, string operation) { if (!success) ThrowLastError(operation); }
    static void ThrowLastError(string operation) { throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }

    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct LUID { public uint LowPart; public int HighPart; }
    [StructLayout(LayoutKind.Sequential)] struct LUID_AND_ATTRIBUTES { public LUID Luid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION
    { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS
    { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int type, IntPtr buffer, uint size, out uint required);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool LookupPrivilegeNameW(string system, ref LUID luid, StringBuilder name, ref uint length);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int type, ref SID_AND_ATTRIBUTES information, uint length);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SaferCreateLevel(uint scope, uint level, uint flags, out IntPtr handle, IntPtr reserved);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SaferComputeTokenFromLevel(IntPtr level, IntPtr input, out IntPtr output, uint flags, IntPtr reserved);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SaferCloseLevel(IntPtr level);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSidW(string text, out IntPtr sid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);
    [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr information, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    delegate bool EnumWindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint thread, EnumWindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int identifier);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr required);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
}
