import { describe, expect, it } from 'vitest';
import { adminDashboardHtml } from '../src/admin/dashboard';

const SERVER_NAME = 'matrix.example.org';

describe('adminDashboardHtml (pure output)', () => {
  it('returns a deterministic string for a given server name', () => {
    const html = adminDashboardHtml(SERVER_NAME);
    expect(typeof html).toBe('string');
    expect(html).toBe(adminDashboardHtml(SERVER_NAME));
  });

  it('embeds the server name in the title, sidebar, server info and URL helpers', () => {
    const html = adminDashboardHtml(SERVER_NAME);
    expect(html).toContain(`<title>Matrix-Worker Admin - ${SERVER_NAME}</title>`);
    expect(html).toContain(`<div class="server-name">${SERVER_NAME}</div>`);
    expect(html).toContain(`<div class="value">${SERVER_NAME}</div>`);
    expect(html).toContain(`https://${SERVER_NAME}/auth/oidc/providers`);
    expect(html).toContain(`placeholder="@user:${SERVER_NAME}"`);
  });

  it('contains the expected navigation entries and section headings', () => {
    const html = adminDashboardHtml(SERVER_NAME);
    const markers = [
      'data-page="users"',
      'data-page="rooms"',
      'data-page="federation"',
      '<h2>Dashboard</h2>',
      '<h2>Users</h2>',
      '<h2>Rooms</h2>',
      '<h2>Media Files</h2>',
      '<h2>Content Reports</h2>',
      '<h2>Audit Log</h2>',
      '<h2>Federation</h2>',
      '<h2>Bots &amp; Bridges</h2>',
      '<h2>Identity Providers</h2>',
      '<h2>Settings</h2>',
      'Activity Overview',
      'User Breakdown',
      'Quick Actions',
      'Server Information',
      'Federation Status',
      'Federation Test Results',
      'Known Servers',
      'Registration Tokens',
      'Admin Management',
      'Send Server Notice',
    ];
    for (const marker of markers) {
      expect(html, `missing marker: ${marker}`).toContain(marker);
    }
  });

  it('interpolates the server name verbatim (the source does not HTML-escape it)', () => {
    // The template injects ${serverName} directly, so pin that pure behavior
    // rather than asserting escaping that the source does not perform.
    const raw = `<script>alert("x" & 'y')</script>`;
    const html = adminDashboardHtml(raw);
    expect(html).toContain(`<title>Matrix-Worker Admin - ${raw}</title>`);
    expect(html).toContain(`<div class="server-name">${raw}</div>`);
    expect(html).toContain(raw);
  });
});
