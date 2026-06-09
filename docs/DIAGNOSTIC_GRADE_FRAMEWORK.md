# What Makes an Instrument "Diagnostic Grade"

### A cross-disciplinary, measurement-science foundation for "good enough to act on"

**Purpose.** This document gives a rigorous, citable answer to a question we have only answered by intuition: *what are the technical requirements for an instrument to be trusted for diagnosis and decision-making?* It draws the answer from the disciplines that have already formalised it — metrology, clinical/in-vitro diagnostics, analytical chemistry, non-destructive testing, psychometrics, and signal-detection theory — and synthesises a concrete requirements framework, then maps each requirement onto a software observability instrument.

**The one-sentence thesis.** Across every measurement discipline, "diagnostic grade" is not a vibe — it is *fitness for a stated purpose*, demonstrated by independently evidencing a small, recurring set of properties (validity, reliability, trueness, sensitivity, specificity, detection limit, traceability/calibration, and quantified uncertainty), each measured against a pre-declared target, and each re-checked over time. A measured quantity earns the right to be acted upon only when all of these are shown — not assumed.

---

## 1. The unifying principle: *fitness for purpose*

Every discipline converges on the same organising idea, and metrology states it most precisely. The International Vocabulary of Metrology (VIM) distinguishes **verification** — objective evidence that an item meets *specified* requirements — from **validation** — verification where those requirements are *adequate for the intended use* ([JCGM/VIM 2.44–2.45](https://jcgm.bipm.org/vim/en/2.44.html)). The bridge between them is the VIM's notion of a **target measurement uncertainty**: an upper limit on uncertainty *decided in advance from how the result will be used* ([VIM 2.34](https://jcgm.bipm.org/vim/en/2.34.html)). Analytical chemistry says the same thing in plainer words: a method is validated when its performance characteristics are shown to be suitable for the intended purpose, i.e. reliable enough that "any decision based on it can be taken with confidence" ([Eurachem, *Method Validation*](https://www.eurachem.org/index.php/mnu-tsk-mv)); IUPAC/RSC define fitness for purpose as the degree to which the data let a user "make technically and administratively correct decisions" ([RSC *Analyst*, 1996](https://pubs.rsc.org/en/content/articlelanding/1996/an/an9962100275)).

Three consequences fall out of this, and they are the backbone of everything below:

1. **"Diagnostic grade" is relative to a declared use.** There is no absolute grade; there is a grade *for a stated decision*. The threshold must be set before measurement, from the cost of being wrong.
2. **Working ≠ measuring the right thing.** Verification (it functions to spec) is not validation (the spec is the right spec). An instrument can pass every internal check and still be diagnostically worthless if the spec was wrong.
3. **A bare number is inadmissible.** A result is only complete when it carries a statement of its own uncertainty, so the user can judge reliability ([JCGM 100:2008, GUM](https://www.bipm.org/documents/20126/2071204/JCGM_100_2008_E.pdf)).

---

## 2. What each discipline requires

### 2.1 Metrology (BIPM/JCGM VIM & GUM; ISO/IEC 17025)

Metrology is the parent discipline; the others are specialisations. Its requirements:

- **Metrological traceability** — the result must be relatable to a reference (ideally the SI) through a *documented, unbroken chain of calibrations, each contributing to the uncertainty* ([VIM 2.41](https://jcgm.bipm.org/vim/en/2.41.html)). Traceability is a property of the **result**, not of the instrument or the lab. Crucially, traceability alone does **not** guarantee the uncertainty is adequate or that no mistakes were made ([VIM 2.41 Note 5](https://jcgm.bipm.org/vim/en/2.41.html)).
- **Calibration** relates reference-standard values (with their uncertainties) to the instrument's indications, then lets you turn an indication into a result ([VIM 2.39](https://jcgm.bipm.org/vim/en/2.39.html)). It must not be confused with adjustment or with verification.
- **Measurement uncertainty** — a non-negative parameter for the dispersion of values reasonably attributable to the measurand ([VIM 2.26](https://jcgm.bipm.org/vim/en/2.26.html)). Reported as an **expanded uncertainty** `U = k·u_c`, stating the coverage factor `k` and confidence level ([GUM §7.2.3](https://www.iso.org/sites/JCGM/GUM/JCGM100/C045315e-html/C045315e_FILES/MAIN_C045315e/07_e.html)).
- **Accuracy decomposed into trueness + precision.** Accuracy is the closeness of a measured value to the true value and is *not* given a number ([VIM 2.13](https://jcgm.bipm.org/vim/en/2.13.html)). It splits into **trueness** (closeness of the *mean* of many results to a reference — i.e. inverse of systematic error / **bias**, [VIM 2.14](https://jcgm.bipm.org/vim/en/2.14.html)) and **precision** (closeness of repeated results to *each other*, a standard deviation, [VIM 2.15](https://jcgm.bipm.org/vim/en/2.15.html)). These are orthogonal: an instrument can be precise and biased, or true-on-average but noisy.
- **Repeatability vs reproducibility** — precision measured holding everything constant ([VIM 2.20](https://jcgm.bipm.org/vim/en/2.20.html)) vs deliberately varying operators, location, and systems ([VIM 2.24](https://jcgm.bipm.org/vim/en/2.24.html)).
- **Resolution** — the smallest input change that produces a perceptible change in the indication ([VIM 4.14](https://jcgm.bipm.org/vim/en/4.14.html)).
- **Institutional competence** — ISO/IEC 17025:2017 codifies the lab-level assurance: competent personnel, proficiency testing, traceable reference materials, maintained/calibrated equipment ([ISO/IEC 17025](https://www.iso.org/standard/66912.html)).

**Numeric convention:** for a normal distribution, `k = 2` gives ≈ 95% coverage (the accredited-lab default); `k = 3` ≈ 99.7% ([GUM Annex G](https://www.bipm.org/documents/20126/2071204/JCGM_100_2008_E.pdf)).

### 2.2 Clinical / in-vitro diagnostics — the literal home of the term

Clinical diagnostics is where "diagnostic grade" is an actual regulatory bar. It layers three distinct validities (the **ACCE** framework: **A**nalytic validity, **C**linical validity, **C**linical utility, plus **E**thical/legal/social, [CDC ACCE](https://archive.cdc.gov/www_cdc_gov/genomics/gtesting/acce/index.htm)):

- **Analytical validity** — does the assay measure the analyte correctly? Characterised per the CLSI EP-series: precision (EP05), detection capability LoB/LoD/LoQ (EP17), linearity (EP06), interference (EP07), method comparison/bias (EP09) ([CLSI](https://clsi.org/resources/insights-blog/verifying-performance-claims-for-medical-laboratory-tests/)). Detection capability is a three-tier construct: **Limit of Blank** `LoB = mean_blank + 1.645·SD_blank`; **Limit of Detection** (lowest reliably distinguished from LoB); **Limit of Quantitation** (lowest measurable at a pre-set bias/imprecision goal) ([Clin Biochem Rev, PMC2556583](https://pmc.ncbi.nlm.nih.gov/articles/PMC2556583/)). ISO 5725 anchors the accuracy = trueness + precision split, with precision tiered as repeatability / intermediate / reproducibility ([ISO 5725-2](https://www.iso.org/standard/69419.html)).
- **Clinical validity** — does the result correctly classify the *clinical state*? Expressed as **diagnostic sensitivity** (true-positive rate) and **specificity** (true-negative rate); **PPV/NPV** (which, unlike sensitivity/specificity, depend on **prevalence**); **likelihood ratios**; **ROC/AUC**; and **Youden's index** `J = Se + Sp − 1` for cutoff selection — all measured against a **reference ("gold") standard** ([Biochem Med, PMC4975285](https://pmc.ncbi.nlm.nih.gov/articles/PMC4975285/); [Turkish J Emerg Med](https://turkjemergmed.com/full-text/851)).
- **Clinical utility** — does using the test improve outcomes? (Necessary for adoption, beyond mere correctness.)
- **Evidence quality is itself regulated.** Diagnostic-accuracy studies must be reported per the **STARD 2015** 30-item checklist ([EQUATOR/STARD](https://www.equator-network.org/reporting-guidelines/stard/)) and appraised for bias via **QUADAS-2** across four domains — patient selection, index test, reference standard, flow & timing ([Ann Intern Med](https://www.acpjournals.org/doi/10.7326/0003-4819-155-8-201110180-00009)).
- **A gatekeeper certifies fitness for *intended use*.** FDA 510(k) (substantial equivalence) or PMA, and EU IVDR 2017/746, which mandates three pillars: scientific validity, analytical performance, clinical performance ([FDA 510(k)](https://www.fda.gov/medical-devices/premarket-submissions-selecting-and-preparing-correct-submission/premarket-notification-510k); [EU IVDR Annex XIII](https://www.legislation.gov.uk/eur/2017/746/annex/XIII/part/A/adopted)).

The deep lesson for us: clinical diagnostics separates *"the instrument reads the analyte correctly"* (analytical) from *"the reading correctly tells you about the world"* (clinical). They are validated **separately**. A perfect assay of the wrong marker is diagnostically useless.

### 2.3 Analytical chemistry & NDT — engineering validation

- **Method validation (ICH Q2(R2), 2023/2024)** standardises the parameters: specificity, linearity, range, accuracy, precision (repeatability / intermediate / reproducibility), LoD, LoQ ([ICH Q2(R2)](https://database.ich.org/sites/default/files/ICH_Q2%28R2%29_Guideline_2023_1130.pdf); [EMA](https://www.ema.europa.eu/en/ich-q2r2-validation-analytical-procedures-scientific-guideline)), plus **robustness** (insensitivity to small *deliberate* internal changes) and **ruggedness** (reproducibility across *external* conditions — labs, analysts, days). Convention: `LoD = 3.3·σ/S`, `LoQ = 10·σ/S` (σ = residual SD, S = calibration slope) ([BioPharm Intl](https://www.biopharminternational.com/view/method-validation-essentials-limit-blank-limit-detection-and-limit-quantitation)).
- **Probability of Detection (POD)** — the reliability measure for inspection. The standard figure of merit is **a90/95**: the smallest flaw detected with 90% probability at 95% confidence ([MIL-HDBK-1823A](https://statistical-engineering.com/wp-content/uploads/2017/10/MIL-HDBK-1823A2009.pdf)). This is detection-limit-with-confidence made explicit, and it is the cleanest analogue for "smallest problem we can reliably catch."
- **Measurement System Analysis (Gauge R&R)** — quantifies how much observed variation comes from the *measurement system* rather than the parts, split into repeatability and reproducibility ([Minitab/AIAG](https://support.minitab.com/en-us/minitab/help-and-how-to/quality-and-process-improvement/measurement-system-analysis/how-to/gage-study/crossed-gage-r-r-study/interpret-the-results/key-results/)). Convention: **%R&R < 10% acceptable, 10–30% marginal, > 30% unacceptable**; **number of distinct categories (ndc) ≥ 5** to resolve parts ([SPC for Excel](https://www.spcforexcel.com/knowledge/measurement-systems-analysis-gage-rr/acceptance-criteria-for-msa/)). *Caveat worth keeping honest:* AIAG itself, and Wheeler, warn the 10/30% bands are convention, not statistical law — a useful reminder that thresholds must be justified by decision cost, not folklore.

### 2.4 Psychometrics & signal-detection theory — the abstract theory

These two give the deepest conceptual distinctions, which protect against the two most common ways to fool yourself.

- **Validity vs reliability (the first distinction).** Reliability is *consistency* (across time, items, raters); validity is *correctness of the interpretation* ([BCcampus, Research Methods](https://opentextbc.ca/researchmethods/chapter/reliability-and-validity-of-measurement/)). The modern unified view (AERA/APA/NCME *Standards*, after Messick and Cronbach & Meehl) defines validity as the degree to which evidence supports the *interpretations of scores for proposed uses* — a property of *uses*, not of the instrument, accumulated from many evidence types and never "finished" ([APA Standards](https://www.apa.org/science/programs/testing/standards); [Cronbach & Meehl 1955](http://psychclassics.yorku.ca/Cronbach/construct.htm)). The killer fact: **reliability is necessary but not sufficient for validity, and it caps it** — observed validity cannot exceed √(reliability), so an unreliable instrument *mechanically* cannot be valid ([SimplyPsychology](https://www.simplypsychology.org/reliability-or-validity.html)). A scale that always reads 5 lb heavy is perfectly reliable and perfectly invalid.
- **Discriminability vs bias (the second distinction).** Signal-detection theory separates **d′** — how far apart the signal and noise distributions sit, an intrinsic property of measurement acuity — from the **criterion c** — *where you set the threshold*, a policy choice ([Birmingham, SDT intro](https://www.birmingham.ac.uk/Documents/college-les/psych/vision-laboratory/sdtintro.pdf)). Two instruments with identical true acuity can post wildly different false-alarm rates purely from different thresholds. **AUC** (= probability a random positive outranks a random negative; 0.5 chance, 1.0 perfect) measures discrimination *across all thresholds*, independent of the operating point ([Hanley & McNeil, via Columbia Mailman](https://www.publichealth.columbia.edu/research/population-health-methods/evaluating-risk-prediction-roc-curves)). The operating point itself is a cost-of-error decision, not a property of the instrument.

**Numeric conventions:** Cronbach's α ≈ 0.70 acceptable / 0.80–0.90 good / ≥ 0.90 for individual decisions (contested — [Sijtsma 2009](https://link.springer.com/article/10.1007/s11336-008-9101-0)); Landis–Koch κ bands (0.41–0.60 moderate, 0.61–0.80 substantial, 0.81–1.0 almost perfect); AUC ≈ 0.7–0.8 acceptable, 0.8–0.9 excellent, > 0.9 outstanding.

---

## 3. The convergent definition: eight recurring axes

Stripping the discipline-specific vocabulary, the *same eight properties* recur as the definition of a trustworthy, diagnostic-grade instrument. This is the core result.

| # | Axis | The question it answers | Where it comes from |
|---|---|---|---|
| 1 | **Validity** | Does it measure the right thing — the quantity that actually matters for the decision? | Psychometrics (construct/criterion); IVD clinical validity |
| 2 | **Reliability / reproducibility** | Same input → same result, across time, operators, conditions? | Metrology (repeatability/reproducibility); MSA (Gauge R&R); psychometrics |
| 3 | **Trueness / bias** | Is it right *on average*, or systematically off? | Metrology (VIM 2.14); ISO 5725; method-comparison bias |
| 4 | **Sensitivity** | Does it catch the real signal (true-positive rate / detection)? | IVD; signal-detection theory; NDT POD |
| 5 | **Specificity** | Does it avoid false alarms (true-negative rate)? | IVD; signal-detection theory |
| 6 | **Detection limit / resolution** | What is the *smallest* real change it can reliably register? | IVD (LoB/LoD/LoQ); NDT (a90/95); metrology (resolution) |
| 7 | **Traceability / calibration** | Is it anchored to an external reference, and re-anchored over time? | Metrology (traceability chain, calibration, ISO 17025) |
| 8 | **Quantified uncertainty** | Does every result carry a stated confidence, with a *pre-declared* target? | Metrology (GUM, target uncertainty); the fitness-for-purpose principle |

Two meta-requirements wrap these eight:

- **Validation over verification** — the targets in #1–#8 must themselves be shown adequate for the intended use, not merely met (VIM 2.45).
- **Evidence discipline** — the demonstration must be reported and bias-appraised to a standard (STARD/QUADAS in IVD; ISO 17025 in metrology), so the claim is auditable, not asserted.

The deepest single insight, recurring in metrology (traceability ≠ adequacy), psychometrics (reliable ≠ valid), and SDT (low false-alarm ≠ good acuity): **an instrument can pass its internal checks and still be diagnostically invalid.** Internal consistency is necessary and cheap; external correctness against a reference is the hard, decisive part.

---

## 4. The requirements framework, mapped to an observability instrument

Now the payoff. A monitoring/observability system *is* a measurement instrument: it claims to measure a service's reliability and to tell you when to act. Each axis translates directly, with a concrete, measurable acceptance test.

| Axis (discipline origin) | Diagnostic-grade requirement | Observability analogue | Concrete metric / acceptance test |
|---|---|---|---|
| **1. Validity** (psychometrics, IVD clinical validity) | The measured quantity reflects the construct that matters | SLIs actually track user-perceived reliability, not a convenient proxy | Correlation of SLI breaches with real user-impacting incidents; construct review that each SLO maps to a user outcome |
| **2. Reliability / reproducibility** (metrology, MSA) | Same inputs → same verdict | Re-running the evaluation on the same pack/state yields the identical grade; deterministic diff | Reproducibility check: identical inputs → identical output (our self-diff `alignment = 1.0` is exactly this); a "Gauge R&R" for the scoring pipeline |
| **3. Trueness / bias** (metrology, ISO 5725) | No systematic over- or under-statement | The score is not systematically inflated (e.g., by counting declared-but-unverified controls as present) | Bias estimate of declared vs verified posture; the declared/verified gap is the bias term |
| **4. Sensitivity** (SDT, IVD, NDT) | Catches real degradations | Incident catch rate; **MTTD** | Fraction of real incidents that fired an alert within the MTTD target; recall against an incident ground-truth set |
| **5. Specificity** (SDT, IVD) | Doesn't cry wolf | Alert precision / false-alarm rate | 1 − (false alerts / total alerts); track the alert-precision operating point explicitly |
| **6. Detection limit / resolution** (IVD LoD, NDT a90/95) | Smallest real change reliably caught | Smallest SLO degradation or error-rate change that reliably trips detection | An "a90/95 for observability": the smallest budget burn detected 90% of the time at 95% confidence |
| **7. Traceability / calibration** (metrology, ISO 17025) | Anchored to a reference; re-anchored on a cadence | **Declared config matches the live system** — the drift problem — re-verified on a schedule | Declared-vs-live drift ratio within tolerance; freshness window on the last verification (the calibration interval) |
| **8. Quantified uncertainty** (GUM, target uncertainty) | Every verdict carries confidence against a pre-set target | The grade reports its own confidence and the threshold was set in advance from decision cost | A coverage statement on the verdict; a pre-declared pass threshold justified by the cost of a missed incident |

**The two meta-requirements map cleanly too:**

- **Validation > verification.** A pack can be 100% schema-conformant (verification) and still measure the wrong service-reality (invalid). This is precisely why a clean static conformance score is *not* a diagnostic-grade verdict — it verifies the manifest, not the running system.
- **Traceability ≠ adequacy** (VIM 2.41 Note 5) is the single most important borrowed caveat: an observability pack can be perfectly traceable to a declared spec and still be inadequate for the decision. Calibration to *the declared config* is worthless if the declared config isn't the live one — which is the drift gap, axis #7.

---

## 5. A defensible definition

Putting it together, here is a definition you can stand behind on stage and use to ground the standard:

> **An observability instrument is *diagnostic grade* when, for an explicitly stated decision (e.g., "is this service healthy enough to release / page on / trust"), it demonstrably satisfies — and re-demonstrates on a defined cadence — eight measured properties: (1) construct *validity* (its indicators track real user impact), (2) *reproducibility* (identical inputs yield identical verdicts), (3) bounded *bias* (declared posture is not systematically overstated vs verified reality), (4) *sensitivity* (a quantified incident catch-rate within an MTTD target), (5) *specificity* (a quantified alert-precision / false-alarm bound), (6) a stated *detection limit* (the smallest degradation reliably caught, with confidence), (7) *traceability/calibration* (declared configuration verified against the live system within a freshness window), and (8) *quantified uncertainty* (each verdict carries a confidence statement against a pre-declared, decision-cost-justified threshold) — with each target shown adequate for the decision (validation, not mere verification) and the evidence reported to an auditable standard.**

In one breath: **diagnostic grade = fitness for a declared decision, evidenced on all eight axes, validated not just verified, and kept calibrated against the live world.** "Good enough" stops being a gut feeling and becomes: *the eight targets are met, the targets were set from the cost of being wrong, and the calibration is fresh.*

---

## 6. How this sharpens the ObservabilityPack standard

Three concrete implications, each traceable to a discipline:

1. **Static conformance is verification, not validation.** Borrow the IVD analytical-vs-clinical split: keep the schema/rubric score, but it must be paired with a *clinical-validity* analogue — evidence the SLIs catch real incidents — before any "diagnostic grade" claim. (This is the same gap as the attestation/freshness recommendation in the spec gap-analysis.)
2. **Calibration needs a freshness interval.** Metrology never calls a result traceable without a stated calibration interval; the pack should carry a verification-freshness window, and a stale verification should *fail* the grade regardless of the static score.
3. **Sensitivity and specificity are first-class, with operating points.** Borrow SDT: report the detection operating point (catch-rate vs false-alarm-rate) explicitly, and choose the threshold from the cost of a missed incident vs an alert-fatigue false alarm — not from a default.

---

## Sources

**Metrology** — JCGM/VIM ([2.13](https://jcgm.bipm.org/vim/en/2.13.html), [2.14](https://jcgm.bipm.org/vim/en/2.14.html), [2.15](https://jcgm.bipm.org/vim/en/2.15.html), [2.26](https://jcgm.bipm.org/vim/en/2.26.html), [2.34](https://jcgm.bipm.org/vim/en/2.34.html), [2.39](https://jcgm.bipm.org/vim/en/2.39.html), [2.41](https://jcgm.bipm.org/vim/en/2.41.html), [2.44–2.45](https://jcgm.bipm.org/vim/en/2.44.html), [4.14](https://jcgm.bipm.org/vim/en/4.14.html)); [JCGM 100:2008 GUM](https://www.bipm.org/documents/20126/2071204/JCGM_100_2008_E.pdf) & [GUM §7 reporting](https://www.iso.org/sites/JCGM/GUM/JCGM100/C045315e-html/C045315e_FILES/MAIN_C045315e/07_e.html); [ISO/IEC 17025:2017](https://www.iso.org/standard/66912.html); [NIST traceability](https://www.nist.gov/metrology/metrological-traceability).
**Clinical / IVD** — [CDC ACCE](https://archive.cdc.gov/www_cdc_gov/genomics/gtesting/acce/index.htm); [CLSI EP-series overview](https://clsi.org/resources/insights-blog/verifying-performance-claims-for-medical-laboratory-tests/); [LoB/LoD/LoQ, Clin Biochem Rev (PMC2556583)](https://pmc.ncbi.nlm.nih.gov/articles/PMC2556583/); [diagnostic accuracy measures, Biochem Med (PMC4975285)](https://pmc.ncbi.nlm.nih.gov/articles/PMC4975285/); [ISO 5725-2](https://www.iso.org/standard/69419.html); [STARD 2015](https://www.equator-network.org/reporting-guidelines/stard/); [QUADAS-2](https://www.acpjournals.org/doi/10.7326/0003-4819-155-8-201110180-00009); [FDA 510(k)](https://www.fda.gov/medical-devices/premarket-submissions-selecting-and-preparing-correct-submission/premarket-notification-510k); [EU IVDR Annex XIII](https://www.legislation.gov.uk/eur/2017/746/annex/XIII/part/A/adopted).
**Analytical chemistry / NDT** — [ICH Q2(R2)](https://database.ich.org/sites/default/files/ICH_Q2%28R2%29_Guideline_2023_1130.pdf); [Eurachem method validation](https://www.eurachem.org/index.php/mnu-tsk-mv) & [Fitness-for-Purpose guide](https://www.eurachem.org/images/stories/Guides/pdf/MV_guide_3rd_ed_V1_EN.pdf); [RSC *Analyst* fitness-for-purpose](https://pubs.rsc.org/en/content/articlelanding/1996/an/an9962100275); [MIL-HDBK-1823A POD](https://statistical-engineering.com/wp-content/uploads/2017/10/MIL-HDBK-1823A2009.pdf); [AIAG MSA Gauge R&R criteria](https://www.spcforexcel.com/knowledge/measurement-systems-analysis-gage-rr/acceptance-criteria-for-msa/); [ISO 9712](https://www.iso.org/standard/75614.html).
**Psychometrics / SDT** — [AERA/APA/NCME Standards](https://www.apa.org/science/programs/testing/standards); [Cronbach & Meehl 1955](http://psychclassics.yorku.ca/Cronbach/construct.htm); [Sijtsma 2009 on Cronbach's α](https://link.springer.com/article/10.1007/s11336-008-9101-0); [reliability vs validity, SimplyPsychology](https://www.simplypsychology.org/reliability-or-validity.html); [BCcampus Research Methods](https://opentextbc.ca/researchmethods/chapter/reliability-and-validity-of-measurement/); [ROC/AUC, Columbia Mailman](https://www.publichealth.columbia.edu/research/population-health-methods/evaluating-risk-prediction-roc-curves); [signal detection theory, Univ. of Birmingham](https://www.birmingham.ac.uk/Documents/college-les/psych/vision-laboratory/sdtintro.pdf).

*Method note: findings were gathered by parallel multi-source web research and verified against the primary standards bodies (BIPM/JCGM, ISO, CLSI, FDA, ICH, Eurachem, AERA/APA/NCME) wherever the canonical document was reachable. Numeric thresholds quoted as "conventions" (Gauge R&R 10/30%, Cronbach α 0.7/0.8/0.9, AUC bands) are widely used industry/field rules of thumb, not laws — and, per the disciplines themselves, must be justified from decision cost rather than adopted by default.*
