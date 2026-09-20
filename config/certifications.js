'use strict';

/**
 * SAP credentials, replacing the MB-/PL-/MS- exam list of DynamicsHub and the Trailhead
 * list of Salesforce Hub. Grouped by the line of work a consultant would describe
 * themselves as being in, so the profile builder can render optgroups without a second
 * mapping.
 *
 * **The exam code carries no year.** SAP re-versions its codes annually — `C_TS4FI_2021`
 * becomes `C_TS4FI_2023` and so on — and a stored string with a year in it is wrong within
 * twelve months of being typed. So the STEM is stored (`C_TS4FI`) and the label is what a
 * person reads. A consultant certified in an older version is still certified; the year is
 * not what the badge is claiming.
 *
 * SAP also renamed its tiers ("SAP Certified Application Associate" → "SAP Certified
 * Associate") partway through the current catalogue, which is a second reason the label is
 * written plainly rather than reproducing whatever SAP's marketing calls the tier this
 * quarter. The tier that matters — Associate, Specialist, Professional — is the `tier`
 * field, and that is what the profile badge renders.
 *
 * Treat this list as editorial, not as an authority. It is what the profile builder offers;
 * `other` exists because it will never be complete.
 */
const CERTIFICATIONS = [
  {
    group: 'Foundation & Methodology',
    items: [
      { code: 'C_TS410', tier: 'Associate', label: 'Business Process Integration with SAP S/4HANA' },
      { code: 'C_ACT', tier: 'Associate', label: 'SAP Activate Project Manager' },
      { code: 'C_S4CPR', tier: 'Associate', label: 'SAP S/4HANA Cloud Public Edition — Implementation' },
      { code: 'E_S4CPE', tier: 'Specialist', label: 'SAP S/4HANA Cloud Private Edition — Implementation' }
    ]
  },
  {
    group: 'Finance',
    items: [
      { code: 'C_TS4FI', tier: 'Associate', label: 'SAP S/4HANA Financial Accounting' },
      { code: 'C_TS4CO', tier: 'Associate', label: 'SAP S/4HANA Management Accounting' },
      { code: 'P_S4FIN', tier: 'Professional', label: 'SAP S/4HANA for Financial Accounting Associates' },
      { code: 'C_S4FTR', tier: 'Associate', label: 'SAP S/4HANA Treasury & Risk Management' },
      { code: 'C_S4FCC', tier: 'Associate', label: 'SAP S/4HANA Finance for Group Reporting' }
    ]
  },
  {
    group: 'Supply Chain & Manufacturing',
    items: [
      { code: 'C_TS452', tier: 'Associate', label: 'SAP S/4HANA Sourcing & Procurement' },
      { code: 'C_TS462', tier: 'Associate', label: 'SAP S/4HANA Sales' },
      { code: 'C_TS422', tier: 'Associate', label: 'SAP S/4HANA Production Planning & Manufacturing' },
      { code: 'C_S4EWM', tier: 'Associate', label: 'Extended Warehouse Management (EWM)' },
      { code: 'C_S4TM', tier: 'Associate', label: 'Transportation Management (TM)' },
      { code: 'C_TS413', tier: 'Associate', label: 'SAP S/4HANA Asset Management' },
      { code: 'C_IBP', tier: 'Associate', label: 'SAP Integrated Business Planning' }
    ]
  },
  {
    group: 'Human Experience',
    items: [
      { code: 'C_THR81', tier: 'Associate', label: 'SuccessFactors Employee Central Core' },
      { code: 'C_THR82', tier: 'Associate', label: 'SuccessFactors Performance & Goals' },
      { code: 'C_THR83', tier: 'Associate', label: 'SuccessFactors Recruiting (Recruiter Experience)' },
      { code: 'C_THR84', tier: 'Associate', label: 'SuccessFactors Recruiting (Candidate Experience)' },
      { code: 'C_THR85', tier: 'Associate', label: 'SuccessFactors Succession Management' },
      { code: 'C_THR86', tier: 'Associate', label: 'SuccessFactors Compensation' },
      { code: 'C_THR88', tier: 'Associate', label: 'SuccessFactors Learning Management' },
      { code: 'C_THR94', tier: 'Associate', label: 'SuccessFactors Time Management' },
      { code: 'C_THR97', tier: 'Associate', label: 'SuccessFactors Onboarding' },
      { code: 'C_HRHPC', tier: 'Associate', label: 'SuccessFactors Employee Central Payroll' }
    ]
  },
  {
    group: 'Spend Management',
    items: [
      { code: 'C_ARSOR', tier: 'Associate', label: 'SAP Ariba Sourcing' },
      { code: 'C_ARCON', tier: 'Associate', label: 'SAP Ariba Contracts' },
      { code: 'C_ARP2P', tier: 'Associate', label: 'SAP Ariba Procurement' },
      { code: 'C_ARSUM', tier: 'Associate', label: 'SAP Ariba Supplier Management' },
      { code: 'C_ARSCC', tier: 'Associate', label: 'SAP Ariba Supply Chain Collaboration' },
      { code: 'C_ARCIG', tier: 'Associate', label: 'SAP Ariba Integration with Cloud Integration Gateway' }
    ]
  },
  {
    group: 'Development & Extension',
    items: [
      { code: 'C_ABAPD', tier: 'Associate', label: 'Back-End Developer — ABAP Cloud' },
      { code: 'C_TAW12', tier: 'Associate', label: 'ABAP with SAP NetWeaver' },
      { code: 'C_FIORD', tier: 'Associate', label: 'SAP Fiori Application Developer' },
      { code: 'C_CPE', tier: 'Associate', label: 'SAP BTP Extension Developer' },
      { code: 'C_CPI', tier: 'Associate', label: 'SAP Integration Suite' },
      { code: 'P_BTPA', tier: 'Professional', label: 'SAP BTP Architect' }
    ]
  },
  {
    group: 'Platform & Operations',
    items: [
      { code: 'C_TADM', tier: 'Associate', label: 'SAP System Administration (Basis)' },
      { code: 'C_HANATEC', tier: 'Associate', label: 'SAP HANA Technology' },
      { code: 'C_HANADEV', tier: 'Associate', label: 'SAP HANA Application Development' },
      { code: 'C_SECAUTH', tier: 'Associate', label: 'SAP System Security & Authorisations' },
      { code: 'C_GRCAC', tier: 'Associate', label: 'SAP Access Control' }
    ]
  },
  {
    group: 'Data & Analytics',
    items: [
      { code: 'C_SAC', tier: 'Associate', label: 'SAP Analytics Cloud' },
      { code: 'C_SACP', tier: 'Associate', label: 'SAP Analytics Cloud — Planning' },
      { code: 'C_DSPH', tier: 'Associate', label: 'SAP Datasphere' },
      { code: 'C_BW4H', tier: 'Associate', label: 'SAP BW/4HANA' },
      { code: 'C_DS', tier: 'Associate', label: 'SAP Data Services (BODS)' }
    ]
  },
  {
    group: 'Customer Experience',
    items: [
      { code: 'C_C4H410', tier: 'Associate', label: 'SAP Sales Cloud' },
      { code: 'C_C4H510', tier: 'Associate', label: 'SAP Service Cloud' },
      { code: 'C_C4H320', tier: 'Associate', label: 'SAP Commerce Cloud — Business User' },
      { code: 'P_C4H34', tier: 'Professional', label: 'SAP Commerce Cloud Developer' },
      { code: 'C_C4HCDC', tier: 'Associate', label: 'SAP Customer Data Cloud' }
    ]
  },
  {
    group: 'Architecture',
    items: [
      { code: 'P_SAPEA', tier: 'Professional', label: 'SAP Enterprise Architect' }
    ]
  }
];

const ALL_CERTIFICATIONS = CERTIFICATIONS.flatMap((g) =>
  g.items.map((item) => ({ ...item, group: g.group }))
);
const CERT_BY_CODE = new Map(ALL_CERTIFICATIONS.map((c) => [c.code, c]));

const TIERS = ['Associate', 'Specialist', 'Professional'];

/**
 * The stored value for a credential this list does not carry. SAP's catalogue is larger
 * than any hand-kept list and re-versions constantly, so a profile that cannot say
 * "something else" pushes people into picking the nearest wrong option — which is worse
 * than an unrecognised string, because it looks correct.
 */
const OTHER_CODE = 'OTHER';

function assertCertificationIntegrity() {
  const problems = [];
  const seen = new Set();

  for (const cert of ALL_CERTIFICATIONS) {
    if (seen.has(cert.code)) problems.push(`duplicate certification code: ${cert.code}`);
    seen.add(cert.code);
    if (!/^[A-Z][A-Z0-9_]*$/.test(cert.code)) {
      problems.push(`certification code is not in SAP's shape: ${cert.code}`);
    }
    if (/_\d{4}$/.test(cert.code)) {
      problems.push(`certification code carries a year suffix, which re-versions annually: ${cert.code}`);
    }
    if (!TIERS.includes(cert.tier)) {
      problems.push(`certification ${cert.code} has an unknown tier: ${cert.tier}`);
    }
    if (!cert.label || !cert.label.trim()) problems.push(`certification ${cert.code} has no label`);
  }

  if (seen.has(OTHER_CODE)) {
    problems.push(`${OTHER_CODE} is reserved and must not appear in the catalogue`);
  }

  if (problems.length) {
    throw new Error(`Certification catalogue is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
  return true;
}

function certByCode(code) {
  return CERT_BY_CODE.get(code) || null;
}

/** True for a catalogue code or the reserved `OTHER`. */
function isCertificationCode(code) {
  return code === OTHER_CODE || CERT_BY_CODE.has(code);
}

function certLabel(code) {
  if (code === OTHER_CODE) return 'Other SAP certification';
  const cert = CERT_BY_CODE.get(code);
  return cert ? cert.label : null;
}

module.exports = {
  CERTIFICATIONS,
  ALL_CERTIFICATIONS,
  CERT_BY_CODE,
  TIERS,
  OTHER_CODE,
  assertCertificationIntegrity,
  certByCode,
  isCertificationCode,
  certLabel
};
