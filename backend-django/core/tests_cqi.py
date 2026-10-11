"""Tests for core/cqi.py. SimpleTestCase throughout: no database, no cache."""
import math

from django.test import SimpleTestCase, override_settings

from . import cqi
from .cqi import (
    CAPACITY, EESM, ML_PREDICTION, RSRP_RSRQ, SINR_MAPPING, CqiError, compute_cqi,
    cqi_from_sinr, eesm_effective_sinr_db, sample_cqi_fields,
)

LADDER = {'sinr_thresholds_db': '2DB_LADDER'}


class CqiTableTests(SimpleTestCase):
    def test_table_matches_3gpp_36213_7_2_3_1(self):
        self.assertEqual(cqi.CQI_TABLE[1], ('QPSK', 78, 0.1523))
        self.assertEqual(cqi.CQI_TABLE[6], ('QPSK', 602, 1.1758))
        self.assertEqual(cqi.CQI_TABLE[7], ('16QAM', 378, 1.4766))
        self.assertEqual(cqi.CQI_TABLE[9], ('16QAM', 616, 2.4063))
        self.assertEqual(cqi.CQI_TABLE[10], ('64QAM', 466, 2.7305))
        self.assertEqual(cqi.CQI_TABLE[15], ('64QAM', 948, 5.5547))
        self.assertEqual(sorted(cqi.CQI_TABLE), list(range(16)))

    def test_efficiency_is_bits_per_symbol_times_code_rate(self):
        bits = {'QPSK': 2, '16QAM': 4, '64QAM': 6}
        for index in range(1, 16):
            modulation, rate, efficiency = cqi.CQI_TABLE[index]
            self.assertAlmostEqual(bits[modulation] * rate / 1024, efficiency, places=3)


class SinrMappingTests(SimpleTestCase):
    def test_spec_validation_example(self):
        for config in (None, LADDER):
            r = compute_cqi(sinr_db=10.3, method=SINR_MAPPING, config=config)
            self.assertEqual(r['cqi_index'], 9)
            self.assertEqual(r['modulation'], '16QAM')
            self.assertEqual(r['code_rate_x1024'], 616)
            self.assertAlmostEqual(r['code_rate'], 0.6016, places=4)
            self.assertEqual(r['spectral_efficiency'], 2.4063)
            self.assertEqual(r['method_used'], SINR_MAPPING)

    def test_below_lowest_threshold_is_cqi_0(self):
        r = compute_cqi(sinr_db=-10)
        self.assertEqual(r['cqi_index'], 0)
        self.assertIsNone(r['modulation'])
        self.assertIsNone(r['spectral_efficiency'])

    def test_threshold_is_inclusive_and_top_is_15(self):
        self.assertEqual(compute_cqi(sinr_db=10.0, config=LADDER)['cqi_index'], 9)
        self.assertEqual(compute_cqi(sinr_db=9.99, config=LADDER)['cqi_index'], 8)
        self.assertEqual(compute_cqi(sinr_db=40)['cqi_index'], 15)

    def test_default_table_is_unchanged_from_before_the_module(self):
        # Values the Collections table showed before core/cqi.py existed.
        self.assertEqual([cqi_from_sinr(v) for v in (17, 13, 12, 10, -7)], [12, 10, 10, 8, 0])
        self.assertIsNone(cqi_from_sinr(None))

    def test_custom_threshold_list(self):
        shifted = [t + 3 for t in cqi.SINR_THRESHOLDS_2DB_LADDER]
        self.assertEqual(compute_cqi(sinr_db=10.3, config={'sinr_thresholds_db': shifted})['cqi_index'], 7)

    def test_bad_config_and_input_raise(self):
        for bad in ([1, 2, 3], list(range(15, 0, -1)), 'NO_SUCH_TABLE'):
            with self.assertRaises(CqiError):
                compute_cqi(sinr_db=5, config={'sinr_thresholds_db': bad})
        with self.assertRaises(CqiError):
            compute_cqi(sinr_db=None)
        with self.assertRaises(CqiError):
            compute_cqi(sinr_db=5, method='NOPE')

    def test_settings_override_applies_and_caller_config_wins(self):
        with override_settings(CQI_CONFIG={'sinr_thresholds_db': '2DB_LADDER'}):
            self.assertEqual(compute_cqi(sinr_db=10.0)['cqi_index'], 9)
            self.assertEqual(compute_cqi(sinr_db=10.0, config={'sinr_thresholds_db': 'BRUENINGHAUS'})['cqi_index'], 8)

    def test_subband_list_uses_eesm_by_default_or_mean(self):
        subbands = [0, 20]
        eesm = compute_cqi(sinr_db=subbands)
        mean = compute_cqi(sinr_db=subbands, config={'subband_combine': 'mean'})
        self.assertEqual(mean['effective_sinr_db'], 10.0)
        self.assertLess(eesm['effective_sinr_db'], mean['effective_sinr_db'])


class EesmTests(SimpleTestCase):
    def test_spec_example_in_linear_domain(self):
        # [8, 10, 12] dB, beta 2 -> 8.199 linear -> 9.14 dB.
        self.assertAlmostEqual(eesm_effective_sinr_db([8, 10, 12], 2.0), 9.14, places=2)
        r = compute_cqi(sinr_db=[8, 10, 12], method=EESM, config={'eesm_beta': 2.0, **LADDER})
        self.assertEqual(r['cqi_index'], 8)
        self.assertEqual(r['method_used'], EESM)
        self.assertEqual(r['effective_sinr_db'], 9.14)

    def test_equal_subbands_give_that_sinr(self):
        self.assertAlmostEqual(eesm_effective_sinr_db([7.0, 7.0, 7.0], 2.0), 7.0, places=6)

    def test_effective_sinr_lies_between_min_and_mean_and_weak_subband_dominates(self):
        values = [2, 9, 15, 21]
        effective = eesm_effective_sinr_db(values, 2.0)
        self.assertGreaterEqual(effective, min(values))
        self.assertLessEqual(effective, sum(values) / len(values))

    def test_very_strong_subbands_do_not_break(self):
        self.assertTrue(math.isfinite(eesm_effective_sinr_db([60, 60], 0.5)))

    def test_single_value_passes_through(self):
        self.assertEqual(compute_cqi(sinr_db=10.3, method=EESM)['cqi_index'], 9)

    def test_beta_must_be_positive(self):
        with self.assertRaises(CqiError):
            compute_cqi(sinr_db=[1, 2], method=EESM, config={'eesm_beta': 0})


class RsrqTests(SimpleTestCase):
    def test_spec_example(self):
        r = compute_cqi(rsrq_db=-10, method=RSRP_RSRQ)
        self.assertEqual(r['cqi_index'], 7)
        self.assertEqual(r['modulation'], '16QAM')
        self.assertEqual(r['method_used'], RSRP_RSRQ)
        self.assertIsNone(r['effective_sinr_db'])

    def test_clamped_to_0_15(self):
        self.assertEqual(compute_cqi(rsrq_db=-25, method=RSRP_RSRQ)['cqi_index'], 0)
        self.assertEqual(compute_cqi(rsrq_db=5, method=RSRP_RSRQ)['cqi_index'], 15)

    def test_custom_coefficients(self):
        r = compute_cqi(rsrq_db=-10, method=RSRP_RSRQ, config={'rsrq_slope': 0.5, 'rsrq_intercept': 10})
        self.assertEqual(r['cqi_index'], 5)

    def test_rsrq_required(self):
        with self.assertRaises(CqiError):
            compute_cqi(rsrp_dbm=-95, method=RSRP_RSRQ)


class CapacityTests(SimpleTestCase):
    def test_spec_example(self):
        self.assertAlmostEqual(cqi.capacity_bps_hz(10), 3.459, places=3)
        r = compute_cqi(sinr_db=10, method=CAPACITY, config=LADDER)
        self.assertEqual(r['cqi_index'], 9)
        self.assertEqual(r['method_used'], CAPACITY)

    def test_single_stream_agrees_with_sinr_mapping_on_every_threshold(self):
        for config in (None, LADDER):
            for t in cqi.resolve_config(config)['sinr_thresholds_db']:
                for sinr in (t - 0.05, t, t + 0.05):
                    self.assertEqual(
                        compute_cqi(sinr_db=sinr, method=CAPACITY, config=config)['cqi_index'],
                        compute_cqi(sinr_db=sinr, method=SINR_MAPPING, config=config)['cqi_index'],
                        msg=f'sinr={sinr}',
                    )

    def test_mean_and_sum_across_streams(self):
        mean = compute_cqi(sinr_db=[10, 10], method=CAPACITY, config=LADDER)
        total = compute_cqi(sinr_db=[10, 10], method=CAPACITY, config={'capacity_combine': 'sum', **LADDER})
        self.assertEqual(mean['cqi_index'], 9)
        self.assertGreater(total['cqi_index'], mean['cqi_index'])

    def test_custom_capacity_thresholds(self):
        thresholds = [0.5 * i for i in range(1, 16)]
        self.assertEqual(compute_cqi(sinr_db=10, method=CAPACITY, config={'capacity_thresholds': thresholds})['cqi_index'], 6)


class MlPredictionTests(SimpleTestCase):
    def test_no_model_raises_instead_of_guessing(self):
        with self.assertRaises(CqiError):
            compute_cqi(method=ML_PREDICTION, cqi_history=[7, 8, 9])

    def test_plugged_in_predictor_gets_last_n_values_and_result_is_clamped(self):
        seen = {}

        def predictor(cqi_history, sinr_history):
            seen['cqi'], seen['sinr'] = cqi_history, sinr_history
            return sum(cqi_history) / len(cqi_history) + 0.4

        r = compute_cqi(method=ML_PREDICTION, cqi_history=list(range(1, 13)), sinr_history=[1.0] * 3,
                        config={'ml_predictor': predictor, 'ml_history_length': 10})
        self.assertEqual(seen['cqi'], list(range(3, 13)))
        self.assertEqual(seen['sinr'], [1.0] * 3)
        self.assertEqual(r['cqi_index'], 8)  # mean 7.5 + 0.4 -> 8
        self.assertEqual(r['method_used'], ML_PREDICTION)
        high = compute_cqi(method=ML_PREDICTION, config={'ml_predictor': lambda c, s: 99})
        self.assertEqual(high['cqi_index'], 15)


class SampleFieldsTests(SimpleTestCase):
    def test_reported_cqi_wins(self):
        f = sample_cqi_fields(11, 3, -12, 'LTE')
        self.assertEqual((f['cqi_value'], f['cqi_source'], f['modulation']), (11, 'reported', '64QAM'))

    def test_sinr_then_rsrq_fallback(self):
        f = sample_cqi_fields(None, 17, -12, 'LTE')
        self.assertEqual((f['cqi_value'], f['cqi_source'], f['spectral_efficiency']), (12, 'sinr', 3.9023))
        f = sample_cqi_fields(None, None, -10, 'LTE')
        self.assertEqual((f['cqi_value'], f['cqi_source'], f['modulation']), (7, 'rsrq', '16QAM'))

    def test_out_of_range_report_is_ignored(self):
        # Android's "unavailable" is Integer.MAX_VALUE.
        self.assertEqual(sample_cqi_fields(2147483647, 10.3, None, 'LTE')['cqi_source'], 'sinr')

    def test_non_lte_gets_no_estimate_and_no_lte_table(self):
        self.assertIsNone(sample_cqi_fields(None, 15, -8, 'NR')['cqi_value'])
        f = sample_cqi_fields(9, 15, -8, 'NR')
        self.assertEqual((f['cqi_value'], f['cqi_source'], f['modulation']), (9, 'reported', None))

    def test_nothing_known(self):
        self.assertEqual(set(sample_cqi_fields(None, None, None, 'LTE').values()), {None})
