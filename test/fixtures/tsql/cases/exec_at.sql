EXEC ('SELECT * FROM dbo.RemoteThing') AT LINKSRV2
EXECUTE (@sql) AT [Other Server]
EXEC @procName @a = 1
EXEC @rc = @procName2
EXECUTE AS USER = 'auditor'
REVERT
