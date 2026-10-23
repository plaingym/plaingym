// SPDX-License-Identifier: AGPL-3.0-only
/** Synthetic exports with shared family emails, payer references and saved processor IDs. */
export const familyExport = `Member ID,First Name,Last Name,Email Address,Date of Birth,Status,Phone,Household External ID,Household Name,Billing Day,Email Opt Out,Stripe Customer ID,Stripe Payment Method ID,Tags
P100,Ari,Stone,ari@example.test,1980-04-25,Active,555-0100,,Stone household,15,Yes,cus_Stone,pm_Stone,Adults
P101,Lea,Stone,ari@example.test,2014-08-11,Frozen,,P100,Stone household,,,,,Kids
P200,Kai,River,kai@example.test,1985-11-23,Inactive,,P200,River household,3,No,cus_River,pm_River,Adults; Morning
P201,Mina,River,kai@example.test,2015-11-23,Trial,,P200,River household,,,,,Kids
`;

export const minimalExport = 'First Name,Last Name,Email\nJo,Fields,jo@example.test\n';
