import pytest
from botocore.exceptions import ClientError

from app.destinations.freewheel import FreeWheel, split_location
from app.sync_engine import full_resync_due

PATH = "s3://aim-incoming-data-prd-us-east-1/audience_partner=acme/data_type=segment/client=1234"


class FakeS3:
    def __init__(self, fail=None):
        self.puts, self.fail = [], fail

    def put_object(self, **kw):
        if self.fail:
            raise self.fail
        self.puts.append(kw)
        return {"ETag": '"abc"', "ResponseMetadata": {"HTTPStatusCode": 200}}

    def list_objects_v2(self, **kw):
        if self.fail:
            raise self.fail
        self.listed = kw
        return {"KeyCount": 2}


class FakeSession:
    def client(self, name):
        return type("STS", (), {"get_caller_identity": lambda self: {"Arn": "arn:aws:iam::111122223333:user/cdp"}})()


def dest(s3=None, environment="staging", mapped=("ctv",), taxonomy="", **options):
    d = FreeWheel({"environment": environment, "network_id": "1234", "data_provider_name": "Acme-HT",
                   "bucket_override": PATH, "taxonomy_location": taxonomy, "aws_access_key_id": "AKIA", "aws_secret_access_key": "x"},
                  {"sync_type": "audience", "mode": "all", "sync_id": 7, "run_id": 3, "audience_name": "Newsletter readers",
                   "model_id": 42, "model_name": "Newsletter readers", "mapped_targets": list(mapped), "options": dict(options)})
    d._s3 = s3 or FakeS3()
    d._session = lambda: FakeSession()
    return d


def row(i, **ids):
    return {"id": str(i), "match": None, "fields": ids}


def test_split_location():
    assert split_location(PATH + "/") == ("aim-incoming-data-prd-us-east-1", "audience_partner=acme/data_type=segment/client=1234")
    assert split_location("my-bucket") == ("my-bucket", "audience_partner=mediamint")
    arn = "arn:aws:s3:us-east-1:123:accesspoint/fw"
    assert split_location(arn) == (arn, "audience_partner=mediamint")
    with pytest.raises(ValueError):
        split_location("")


def test_one_headerless_file_per_id_type_under_delivery_date():
    d = dest(mapped=("ctv", "ipv4"))
    errors = d.upsert([row(1, ctv="roku-1", ipv4="10.0.0.1"), row(2, ctv="", ipv4="nope"), row(3, ctv='["fire-1","fire-2"]')])
    assert errors == {"2": "ipv4 value isn't a valid IPv4 address"}
    files = {p["Key"].rsplit("/", 1)[-1].split("_")[0]: p for p in d._s3.puts}
    assert set(files) == {"ctv", "ipv4"}
    ctv = files["ctv"]
    assert ctv["Bucket"] == "aim-incoming-data-prd-us-east-1"
    assert ctv["Key"].startswith("audience_partner=acme/data_type=segment/client=1234/delivery_date=")
    assert " " not in ctv["Key"] and "ctv_net1234_sync7_run3_" in ctv["Key"]
    assert ctv["Body"].decode() == "roku-1,mediamint-sync-7\nfire-1,mediamint-sync-7\nfire-2,mediamint-sync-7\n"
    assert files["ipv4"]["Body"].decode() == "10.0.0.1,mediamint-sync-7\n"


def test_failed_upload_fails_the_rows_for_retry():
    d = dest(FakeS3(fail=ClientError({"Error": {"Code": "AccessDenied"}}, "PutObject")))
    assert set(d.upsert([row(1, ctv="a"), row(2, ctv="b")])) == {"1", "2"}


def test_existing_segment_delivers_membership_only():
    d = dest(segment="existing", segment_id="seg-9", taxonomy="s3://tax/t")
    assert d.prepare() == {} and d._s3.puts == []
    d.upsert([row(1, ctv="roku-1")])
    assert d._s3.puts[0]["Body"].decode() == "roku-1,seg-9\n"
    with pytest.raises(ValueError, match="segment ID"):
        dest(segment="existing").prepare()


def test_new_segment_registered_with_its_settings_on_every_run():
    assert dest(ttl_days=30).prepare() == {}  # no taxonomy location: nothing written
    d = dest(taxonomy="s3://tax-bucket/audience_partner=acme/data_type=taxonomy", segment_name="Acme > {model.name} {model.id}",
             segment_description='Reads "news", daily', cpm_price="1.5", ttl_days="30", custom="true", geo="zip")
    d.prepare()
    put = d._s3.puts[0]
    assert put["Bucket"] == "tax-bucket" and "/taxonomy_net1234_" in put["Key"]
    header, line = put["Body"].decode().splitlines()
    assert header.startswith("Segment ID,Segment Name,TTL,")
    assert line == 'mediamint-sync-7,Acme > Newsletter readers 42,30,"Reads ""news"", daily",1.5,Acme-HT,,Y,N,N,zip,1234'


def test_ttl_out_of_range_stops_before_writing():
    d = dest(ttl_days=91, taxonomy="s3://b/t")
    with pytest.raises(ValueError, match="TTL"):
        d.prepare()
    assert d._s3.puts == []


def test_connection_test_only_reads_and_flags_prod_bucket_on_staging():
    s3 = FakeS3()
    msg = dest(s3).test()
    assert s3.puts == [] and s3.listed["MaxKeys"] == 5
    assert "arn:aws:iam::111122223333:user/cdp" in msg and "looks like production" in msg
    assert "looks like production" not in dest(environment="production").test()


def test_connection_test_explains_access_denied():
    with pytest.raises(ValueError, match="can't list"):
        dest(FakeS3(fail=ClientError({"Error": {"Code": "AccessDenied"}}, "ListObjectsV2"))).test()


def test_full_resync_interval():
    assert not full_resync_due({})
    assert full_resync_due({"full_resync_days": "7"})
    assert not full_resync_due({"full_resync_days": "7", "last_full_resync": "2999-01-01T00:00:00+00:00"})
    assert full_resync_due({"full_resync_days": "7", "last_full_resync": "2020-01-01T00:00:00+00:00"})
