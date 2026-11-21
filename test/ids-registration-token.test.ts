import { describe, it, expect } from 'vitest';
import { generateRegistrationToken } from '../src/utils/ids';

describe('generateRegistrationToken', () => {
	it('returns a single-use invite token with the mrt_ prefix', async () => {
		const token = await generateRegistrationToken();
		expect(token).toMatch(/^mrt_[A-Za-z0-9_-]{43}$/);
		expect(token).not.toMatch(/[+/=]/);
	});

	it('generates a distinct token on every call', async () => {
		const tokens = await Promise.all([
			generateRegistrationToken(),
			generateRegistrationToken(),
			generateRegistrationToken()
		]);
		expect(new Set(tokens).size).toBe(3);
	});
});
