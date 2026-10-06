/**
 * samples.js — Hardcoded sample data for the harness.
 * Kept local to this file: no test data lives anywhere else on disk.
 */

export const SAMPLE_JSON = `{
  "borrower": "J. Alvarez",
  "loan_number": "4471-XA",
  "conditions": [
    "Qualifiedescrow: wait 30 days to pull any escrow reserves from par payment to compare amongst our experience escrow analysis report. If it is, we will allow the PIF premium plan credit and we will allow 2 months of the PMI premium to be in the escrow.reserves please see notes for reserves",
    "Retroactive PMI: PMI coverage in effect on the mortgage loan purchased excluding re-performing loans, include one month premium option available",
    "Appraisal: We ordered the appraisal on 10/2. The report came in at $412,000 with a 90-day effective date. Note: an additional rent schedule may be required if the subject property has a rental unit.",
    "Title: CW Titling — clear the outstanding judgment from the 2019 dissolution; vesting must read \\"John Alvarez and Maria Alvarez, husband and wife\\".",
    "Income: Most recent paystub is missing the year-to-date figure. Provide a VOE dated within 30 days of the note date.",
    "Gift funds: 30% of the down payment is a gift from the maternal aunt; provide the signed gift letter and 5-day seasoned trail."
  ]
}`;

export const SAMPLE_EMAIL = `Subject: Re: Loan 4471-XA — conditions update

From: Tina Fairbanks (Processor) — Tue 10:14 AM

Jonny per underwriter bev — she wants the escrow analysis redone. Wait the full 30 days before pulling reserves from the partial payment thing she mentioned the experience escrow analysis, and we can only allow the 2 months PMI premium into reserves if the PIF premium plan credit is allowed. Also double-check notes for reserves.

She also flagged retro PMI — coverage must be in effect on the mortgage loan purchased, re-performing loans are excluded, and there is a one month premium option available if it helps.

From: Bev parameters (Underwriting) — Tue 12:40 PM

Tina, appraisal was ordered 10/2. Value came in $412,000, effective 90 days. If subject has a rental unit attach an additional rent schedule.

Title item: CW Titling has an unresolved 2019 dissolution judgment. Vesting needs to read John Alvarez and Maria Alvarez husband and wife. No exceptions.

From: Tina Fairbanks — Wed 9:02 AM

Also the latest paystub is missing YTD, we need a fresh VOE dated within 30 days of the note date. And the aunt's gift letter plus the 5 day seasoned trail for that 30% down payment gift still pending from borrower.
`;

export const SAMPLE_OCR = `— CONDlTIONS LIST — page 2 — sc4n quality: f4ir —

1. qu4lifiedescrow: w4it 3O d4ys t0 pull 4ny Escr0w reserves
   fr0m p4r p4yment t0 c0mpare am0ngst our experience escrow
   4n4lysis rep0rt... if 1t 1s, we w1ll 4ll0w the P1F premium
   pl4n credit & 2 m0nths P8I premium 1n escr0w reserves
   (see n0tes f0r reserves)
2. retr0-active PMl: PMl c0ver4ge in effect 0n the m0rtg4ge
   l0an purch4sed exc1ud1ng re-perf0rm1ng 109ns, 1nclude 0ne
   m0nth premium 0pt10n 4v41able
3. Appr4isal ordered 1O/2 vale $4l2,O00 eff. 9O d4ys
   4dd1t10nal rent schedule m4y 8e requ1red 1f subject
   prop3rty h4s rent4l un1t
4. CW T1t1Ing: £lear outstanding 2Ol9 d1ss0lut10n judgment;
   vest1ng must re4d "J0hn Alvarez 4nd Mar1a Alvarez"
5. paystub m1ss1ng YTD figure — need VOE w/1n 3O d4ys 0f
   note d4te
6. g1ft funds 3O% fr0m 4unt: s1gned g1ft letter + 5 d4y
   se4s0ned tr41l
`;
