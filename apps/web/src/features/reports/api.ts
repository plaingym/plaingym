// SPDX-License-Identifier: AGPL-3.0-only
import { reportsContracts, type AttendanceReportQuery, type ReportRangeQuery } from '@plaingym/shared/contracts';
import { api, checked } from '../../lib/api.js';
import { parseResponse } from '../../lib/response.js';

export const reportClient = {
  async attendance(input: AttendanceReportQuery, signal?: AbortSignal) {
    const query = reportsContracts.attendance.query.parse(input);
    return parseResponse(reportsContracts.attendance.response,
      checked(await api.GET('/api/reports/attendance', { params: { query }, ...(signal ? { signal } : {}) }))).data;
  },
  async members(input: ReportRangeQuery, signal?: AbortSignal) {
    const query = reportsContracts.members.query.parse(input);
    return parseResponse(reportsContracts.members.response,
      checked(await api.GET('/api/reports/members', { params: { query }, ...(signal ? { signal } : {}) }))).data;
  },
  async revenue(input: ReportRangeQuery, signal?: AbortSignal) {
    const query = reportsContracts.revenue.query.parse(input);
    return parseResponse(reportsContracts.revenue.response,
      checked(await api.GET('/api/reports/revenue', { params: { query }, ...(signal ? { signal } : {}) }))).data;
  },
};
export type ReportClient = typeof reportClient;
