SELECT t.Payload.value('(/Order/Id)[1]', 'int') AS OrderId,
       Doc.query('/a') AS Q,
       dbo.fn_Calc(t.Id) AS Calc,
       Reporting.fn_Score(t.Id, 2) AS Score
FROM dbo.Orders t
CROSS APPLY t.Payload.nodes('/Order/Line') AS L(x)
WHERE t.Payload.exist('/Order[@Status="X"]') = 1
