'use strict';

/**
 * A sales agent's tax optimisation link (/t/<code>, 2026-11-12): the same code as the
 * sign-up link, counted by the same rules — a person, not a link preview, once per session
 * per agent — but in its OWN session list, so opening one link never uses up the other.
 */
jest.mock('../../models/SalesAgent', () => ({ countOpen: jest.fn(), countTaxOpen: jest.fn() }));

const SalesAgent = require('../../models/SalesAgent');
const { countAgentOpen, countAgentTaxOpen } = require('../../utils/agentOpens');

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const agent = { user_id: 7, code: 'ABCD2345' };
const reqWith = (ua, session = {}) => ({ session, get: () => ua });

beforeEach(() => jest.clearAllMocks());

describe('countAgentTaxOpen', () => {
  it('counts a person once per session', async () => {
    const req = reqWith(BROWSER);
    expect(await countAgentTaxOpen(req, agent)).toBe(true);
    expect(await countAgentTaxOpen(req, agent)).toBe(false);
    expect(SalesAgent.countTaxOpen).toHaveBeenCalledTimes(1);
    expect(SalesAgent.countTaxOpen).toHaveBeenCalledWith(7);
    expect(SalesAgent.countOpen).not.toHaveBeenCalled();
  });

  it('is counted separately from the sign-up link', async () => {
    const req = reqWith(BROWSER);
    expect(await countAgentOpen(req, agent)).toBe(true);
    expect(await countAgentTaxOpen(req, agent)).toBe(true);
    expect(SalesAgent.countOpen).toHaveBeenCalledTimes(1);
    expect(SalesAgent.countTaxOpen).toHaveBeenCalledTimes(1);
  });

  it('does not count a link-preview fetcher', async () => {
    expect(await countAgentTaxOpen(reqWith('WhatsApp/2.23.20.0 A'), agent)).toBe(false);
    expect(SalesAgent.countTaxOpen).not.toHaveBeenCalled();
  });

  it('never throws when the write fails', async () => {
    SalesAgent.countTaxOpen.mockRejectedValueOnce(new Error('no table'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await countAgentTaxOpen(reqWith(BROWSER), agent)).toBe(false);
    spy.mockRestore();
  });

  it('does not count the agent opening their own link, but does count another member', async () => {
    expect(await countAgentTaxOpen(reqWith(BROWSER, { user: { id: 7 } }), agent)).toBe(false);
    expect(await countAgentTaxOpen(reqWith(BROWSER, { user: { id: 99 } }), agent)).toBe(true);
    expect(SalesAgent.countTaxOpen).toHaveBeenCalledTimes(1);
  });

  it('does nothing without an agent', async () => {
    expect(await countAgentTaxOpen(reqWith(BROWSER), null)).toBe(false);
    expect(SalesAgent.countTaxOpen).not.toHaveBeenCalled();
  });
});
