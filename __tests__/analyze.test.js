import { describe, it, expect, vi, beforeEach } from 'vitest'
import { 
  gatherGroundTruth,
  propTypeToField,
  buildPrompt,
  callGemini
} from '../api/analyze.js'

describe('analyze.js exported functions', () => {
  // We'll test the actual implementation without mocking since the functions work correctly
  describe('propTypeToField', () => {
    it('should convert valid prop types to field names', () => {
      expect(propTypeToField('Points OVER')).toBe('ppg')
      expect(propTypeToField('Rebounds UNDER')).toBe('rpg')
      expect(propTypeToField('Assists OVER')).toBe('apg')
      expect(propTypeToField('PRA OVER')).toBe('pra')
    })

    it('should return null for prop types not in PROP_TO_FIELD (regardless of OVER/UNDER)', () => {
      expect(propTypeToField('InvalidStat OVER')).toBeNull()
      expect(propTypeToField('InvalidStat UNDER')).toBeNull()
      // Note: Points without OVER/UNDER returns 'ppg' because the stat exists -
      // the OVER/UNDER validation happens elsewhere in the validation logic
    })
  })
})

// Test that we can import the main functions without errors
describe('analyze.js module imports', () => {
  it('should import gatherGroundTruth function', () => {
    expect(typeof gatherGroundTruth).toBe('function')
  })

  it('should import buildPrompt function', () => {
    expect(typeof buildPrompt).toBe('function')
  })

  it('should import callGemini function', () => {
    expect(typeof callGemini).toBe('function')
  })
})