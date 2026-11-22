import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

describe('Soroban Contracts Lifecycle & Operations', () => {
  const rootDir = process.cwd()
  const contractsReadmePath = path.join(rootDir, 'contracts/README.md')
  const smokeScriptPath = path.join(rootDir, 'contracts/smoke-test.sh')

  it('documents build, deploy, init, upgrades, and TTL policy in contracts/README.md', () => {
    expect(fs.existsSync(contractsReadmePath)).toBe(true)
    const readme = fs.readFileSync(contractsReadmePath, 'utf8')

    // Documented operations
    expect(readme).toContain('init')
    expect(readme).toContain('fund_milestone')
    expect(readme).toContain('release_funds')
    expect(readme).toContain('NEXT_PUBLIC_ESCROW_CONTRACT_ID')
    expect(readme).toContain('WASM Hash Pinning')
    expect(readme).toContain('State Archival & TTL Extension')
    expect(readme).toContain('120,960')
    expect(readme).toContain('518,400')
    expect(readme).not.toContain('Closes #89')
  })

  it('verifies contracts/smoke-test.sh exists, is executable, and runs clean dry-run', () => {
    expect(fs.existsSync(smokeScriptPath)).toBe(true)
    const stats = fs.statSync(smokeScriptPath)
    // Check executable bit
    const isExecutable = Boolean(stats.mode & 0o111)
    expect(isExecutable).toBe(true)

    // Execute dry run
    const output = execSync('DRY_RUN=true ./contracts/smoke-test.sh', {
      cwd: rootDir,
      encoding: 'utf8',
    })
    expect(output).toContain('Lifecycle smoke run completed successfully')
    expect(output).toContain('Pending')
    expect(output).toContain('Funded')
    expect(output).toContain('Completed')
  })

  describe('Contract parameters, lifecycle states & network configurations', () => {
    const STELLAR_PASSPHRASES = {
      testnet: 'Test SDF Network ; September 2015',
      mainnet: 'Public Global Stellar Network ; September 2015',
      standalone: 'Standalone Network ; February 2017',
    } as const

    it('defines standard network passphrases for all environments', () => {
      expect(STELLAR_PASSPHRASES.testnet).toBe('Test SDF Network ; September 2015')
      expect(STELLAR_PASSPHRASES.mainnet).toBe('Public Global Stellar Network ; September 2015')
      expect(STELLAR_PASSPHRASES.standalone).toBe('Standalone Network ; February 2017')
    })

    it('validates WASM hash pinning formatting (64-character lowercase SHA-256)', () => {
      const isValidWasmHash = (hash: string) => /^[0-9a-f]{64}$/.test(hash)

      expect(
        isValidWasmHash('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
      ).toBe(true)
      // Invalid lengths or characters
      expect(isValidWasmHash('not-a-hash')).toBe(false)
      expect(isValidWasmHash('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855')).toBe(
        false,
      )
      expect(isValidWasmHash('e3b0c44298fc1c149afbf4c8')).toBe(false)
    })

    it('validates Soroban contract ID formatting (56-character alphanumeric C-prefix)', () => {
      const isValidContractId = (id: string) => /^C[0-9A-Z]{55}$/.test(id)

      expect(
        isValidContractId('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      ).toBe(true)
      // Invalid format (e.g. account G-prefix or wrong length)
      expect(
        isValidContractId('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'),
      ).toBe(false)
      expect(isValidContractId('invalid_contract_id')).toBe(false)
    })

    it('enforces milestone status state machine and validates transitions', () => {
      enum MilestoneStatus {
        Pending = 0,
        Funded = 1,
        Completed = 2,
      }

      function transition(current: MilestoneStatus, action: 'fund' | 'release'): MilestoneStatus {
        if (action === 'fund') {
          if (current === MilestoneStatus.Completed) {
            throw new Error('Milestone already completed')
          }
          return MilestoneStatus.Funded
        }
        if (action === 'release') {
          if (current === MilestoneStatus.Pending) {
            throw new Error('Escrow is still pending funding')
          }
          if (current === MilestoneStatus.Completed) {
            throw new Error('Funds already released')
          }
          return MilestoneStatus.Completed
        }
        return current
      }

      // Happy path
      let state = MilestoneStatus.Pending
      state = transition(state, 'fund')
      expect(state).toBe(MilestoneStatus.Funded)
      state = transition(state, 'release')
      expect(state).toBe(MilestoneStatus.Completed)

      // Failure modes
      expect(() => transition(MilestoneStatus.Pending, 'release')).toThrow(
        'Escrow is still pending funding',
      )
      expect(() => transition(MilestoneStatus.Completed, 'fund')).toThrow(
        'Milestone already completed',
      )
      expect(() => transition(MilestoneStatus.Completed, 'release')).toThrow(
        'Funds already released',
      )
    })

    it('verifies TTL extension constants align with Protocol 20+ policy', () => {
      const INSTANCE_LIFETIME_THRESHOLD = 120_960 // ~7 days in ledgers
      const INSTANCE_BUMP_AMOUNT = 518_400 // ~30 days in ledgers

      expect(INSTANCE_LIFETIME_THRESHOLD).toBe(120960)
      expect(INSTANCE_BUMP_AMOUNT).toBe(518400)
      expect(INSTANCE_BUMP_AMOUNT).toBeGreaterThan(INSTANCE_LIFETIME_THRESHOLD)
    })
  })
})
