const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const {
	getPlankaToken,
	plankaApiRequest,
	plankaApiRequestAllItems,
	GenericFunctions,
} = require('../nodes/Planka/GenericFunctions');

// ---------------------------------------------------------------------------
// Helpers – fake n8n execution context that delegates HTTP to axios
// ---------------------------------------------------------------------------

const credentials = {
	apiUrl: `${process.env.PLANKA_BASE_URL}/api`,
	email: process.env.PLANKA_ADMIN_EMAIL,
	password: process.env.PLANKA_ADMIN_PASSWORD,
};

/**
 * Translates the n8n-style request options into an axios call so we can hit
 * the real Planka instance without pulling in the full n8n runtime.
 */
async function axiosRequestAdapter(options) {
	const axiosOpts = {
		method: options.method || 'GET',
		url: options.uri || options.url,
		headers: options.headers || {},
	};
	if (options.body) axiosOpts.data = options.body;
	if (options.qs) axiosOpts.params = options.qs;

	const resp = await axios(axiosOpts);
	return resp.data;
}

/** Minimal mock that satisfies `this` inside getPlankaToken / plankaApiRequest */
function createMockExecutionContext() {
	return {
		helpers: {
			request: axiosRequestAdapter,
		},
		getNode: () => ({ name: 'Planka', type: 'n8n-nodes-planka.planka' }),
		getCredentials: async () => credentials,
	};
}

// ---------------------------------------------------------------------------
// State shared across tests (populated during the run)
// ---------------------------------------------------------------------------
let ctx;
let authToken;
let createdProjectId;
let createdBoardId;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

beforeAll(() => {
	if (!credentials.apiUrl || !credentials.email || !credentials.password) {
		throw new Error(
			'Missing Planka credentials in .env – ensure PLANKA_BASE_URL, PLANKA_ADMIN_EMAIL and PLANKA_ADMIN_PASSWORD are set',
		);
	}
	ctx = createMockExecutionContext();
});

// ---------------------------------------------------------------------------
// Cleanup – remove resources created during the test run (order matters)
// ---------------------------------------------------------------------------
afterAll(async () => {
	try {
		// Must obtain a fresh token for cleanup
		const token = await getPlankaToken.call(ctx, credentials);

		if (createdBoardId) {
			await axios.delete(`${credentials.apiUrl}/boards/${createdBoardId}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
		}
		if (createdProjectId) {
			await axios.delete(`${credentials.apiUrl}/projects/${createdProjectId}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
		}
	} catch {
		// best-effort cleanup
	}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getPlankaToken', () => {
	it('should return a valid JWT token string', async () => {
		const token = await getPlankaToken.call(ctx, credentials);
		expect(token).toBeDefined();
		expect(typeof token).toBe('string');
		expect(token.length).toBeGreaterThan(0);
		// JWT tokens have 3 dot-separated parts
		expect(token.split('.').length).toBe(3);
		authToken = token;
	});

	it('should throw on invalid credentials', async () => {
		const badCreds = { ...credentials, password: 'wrong-password-xyz' };
		await expect(getPlankaToken.call(ctx, badCreds)).rejects.toThrow();
	});

	it('should throw on unreachable host', async () => {
		const badCreds = { ...credentials, apiUrl: 'http://127.0.0.1:19999' };
		await expect(getPlankaToken.call(ctx, badCreds)).rejects.toThrow();
	});
});

describe('plankaApiRequest', () => {
	it('should GET /api/config', async () => {
		const response = await plankaApiRequest.call(ctx, 'GET', '/config');
		expect(response).toBeDefined();
		expect(typeof response).toBe('object');
	});

	it('should POST – create a project', async () => {
		const name = `__test_project_${Date.now()}`;
		const response = await plankaApiRequest.call(ctx, 'POST', '/projects', {
			name,
			type: 'private',
		});
		expect(response).toBeDefined();
		expect(response.item).toBeDefined();
		expect(response.item.name).toBe(name);
		createdProjectId = response.item.id;
	});

	it('should GET the created project', async () => {
		expect(createdProjectId).toBeDefined();
		const response = await plankaApiRequest.call(ctx, 'GET', `/projects/${createdProjectId}`);
		expect(response).toBeDefined();
		expect(response.item).toBeDefined();
		expect(response.item.id).toBe(createdProjectId);
	});

	it('should PATCH – update the project name', async () => {
		expect(createdProjectId).toBeDefined();
		const newName = `__test_project_updated_${Date.now()}`;
		const response = await plankaApiRequest.call(ctx, 'PATCH', `/projects/${createdProjectId}`, {
			name: newName,
		});
		expect(response).toBeDefined();
		expect(response.item.name).toBe(newName);
	});

	it('should POST – create a board inside the project', async () => {
		expect(createdProjectId).toBeDefined();
		const name = `__test_board_${Date.now()}`;
		const response = await plankaApiRequest.call(
			ctx,
			'POST',
			`/projects/${createdProjectId}/boards`,
			{ name, position: 1 },
		);
		expect(response).toBeDefined();
		expect(response.item).toBeDefined();
		expect(response.item.name).toBe(name);
		createdBoardId = response.item.id;
	});

	it('should throw for a non-existent resource ID', async () => {
		await expect(
			plankaApiRequest.call(ctx, 'GET', '/projects/999999999999999999'),
		).rejects.toThrow();
	});
});

describe('plankaApiRequestAllItems', () => {
	it('should return an array for projects listing', async () => {
		const items = await plankaApiRequestAllItems.call(ctx, 'GET', '/projects');
		expect(Array.isArray(items)).toBe(true);
		expect(items.length).toBeGreaterThan(0);
	});

	it('should wrap a single object response into an array', async () => {
		expect(createdProjectId).toBeDefined();
		const items = await plankaApiRequestAllItems.call(
			ctx,
			'GET',
			`/projects/${createdProjectId}`,
		);
		expect(Array.isArray(items)).toBe(true);
		expect(items.length).toBe(1);
	});
});

describe('GenericFunctions class', () => {
	let gf;

	beforeAll(async () => {
		gf = new GenericFunctions(ctx);
		// Obtain a token for authenticated requests
		authToken = await getPlankaToken.call(ctx, credentials);
	});

	it('request() – should fetch /api/config (authenticated)', async () => {
		const response = await gf.request({
			method: 'GET',
			uri: `${credentials.apiUrl}/config`,
			headers: { Authorization: `Bearer ${authToken}` },
			json: true,
		});
		expect(response).toBeDefined();
		expect(typeof response).toBe('object');
	});

	it('handleRequest() – should fetch /api/config (authenticated)', async () => {
		const response = await gf.handleRequest({
			method: 'GET',
			uri: `${credentials.apiUrl}/config`,
			headers: { Authorization: `Bearer ${authToken}` },
			json: true,
		});
		expect(response).toBeDefined();
		expect(typeof response).toBe('object');
	});

	it('request() – should throw on unreachable host', async () => {
		await expect(
			gf.request({ method: 'GET', uri: 'http://127.0.0.1:19999/nope' }),
		).rejects.toThrow();
	});

	it('handleRequest() – should throw on unreachable host', async () => {
		await expect(
			gf.handleRequest({ method: 'GET', uri: 'http://127.0.0.1:19999/nope' }),
		).rejects.toThrow();
	});

	it('request() – should throw on 404 resource', async () => {
		await expect(
			gf.request({
				method: 'GET',
				uri: `${credentials.apiUrl}/projects/999999999999999999`,
				headers: { Authorization: `Bearer ${authToken}` },
			}),
		).rejects.toThrow();
	});

	it('should throw when helpers is undefined', async () => {
		const brokenCtx = { getNode: () => ({ name: 'Planka' }) };
		const brokenGf = new GenericFunctions(brokenCtx);
		await expect(
			brokenGf.request({ method: 'GET', uri: `${credentials.apiUrl}/config` }),
		).rejects.toThrow('Helpers is not defined');
	});
});
