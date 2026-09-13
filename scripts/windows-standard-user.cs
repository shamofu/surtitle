// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

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
    {
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
            bool administrator = TokenHasEnabledAdministrators(currentToken);
            if (parentIntegrity < MediumIntegrity)
                throw new InvalidOperationException("The launcher cannot raise a low-integrity process to medium integrity.");

            bool restrict = elevated || administrator || parentIntegrity != MediumIntegrity;
            if (restrict)
            {
                // NORMALUSER removes administrator privileges even when UAC is disabled.
                Check(SaferCreateLevel(2, 0x20000, 1, out saferLevel, IntPtr.Zero), "Create SAFER normal-user level");
                // Flags deliberately remain zero: MAKE_INERT would bypass policy checks.
                Check(SaferComputeTokenFromLevel(saferLevel, currentToken, out restrictedToken, 0, IntPtr.Zero), "Compute SAFER normal-user token");
                SetMediumIntegrity(restrictedToken);
                VerifyToken(restrictedToken, user, session);
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
            try { VerifyToken(childToken, user, session); }
            finally { CloseHandle(childToken); }
            Console.Error.WriteLine("[standard-user] pid={0} elevated=false integrity=8192 admin=false", process.dwProcessId);
            Check(ResumeThread(process.hThread) != Infinite, "Resume verified standard-user process");
            Check(WaitForSingleObject(process.hProcess, Infinite) == 0, "Wait for standard-user process");
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

    static void VerifyToken(IntPtr token, string user, int session)
    {
        if (TokenInteger(token, 20) != 0 || TokenIntegrity(token) != MediumIntegrity || TokenHasEnabledAdministrators(token))
            throw new InvalidOperationException("The child token must be non-elevated, medium-integrity and without an enabled Administrators group.");
        if (TokenUser(token) != user || TokenInteger(token, 12) != session)
            throw new InvalidOperationException("The child token must preserve the caller's user and session.");
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

    static bool TokenHasEnabledAdministrators(IntPtr token)
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
                if ((group.Attributes & 0x4) != 0 && (group.Attributes & 0x10) == 0 &&
                    SidString(group.Sid) == "S-1-5-32-544") return true;
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
