IF @a = 1 PRINT 'one'
IF @b = 1
    UPDATE dbo.T1 SET x = 1
ELSE
    DELETE FROM dbo.T2 WHERE y = 2
IF @c = 1
    SELECT 1
ELSE IF @c = 2
    SELECT 2
ELSE IF EXISTS (SELECT 1 FROM dbo.T3 WHERE z = 3)
    SELECT 3
ELSE
BEGIN
    PRINT 'other'
    RETURN
END
WHILE @i < 10 SET @i = @i + 1
