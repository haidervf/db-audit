DECLARE @msg NVARCHAR(400) = N'DELETE FROM dbo.Fake; EXEC dbo.FakeProc -- not a comment';
DECLARE @url VARCHAR(200) = 'https://myaccount.blob.core.windows.net/container/file.txt';
SELECT 'UPDATE dbo.AlsoFake SET x = 1' AS q, 'srv.db.dbo.tbl' AS dotted, 'it''s FROM dbo.Quoted' AS esc
FROM dbo.Messages
INSERT INTO dbo.Links (Url) VALUES ('https://myaccount.blob.core.windows.net/mycontainer')
