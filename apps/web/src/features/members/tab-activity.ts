// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext } from 'react';

/** Tabs keep their drafts mounted; readers can refresh when their panel becomes visible. */
export const MemberTabActivity = createContext(true);
export const useMemberTabActive = () => useContext(MemberTabActivity);
