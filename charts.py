import matplotlib.pyplot as plt
import pandas as pd
import numpy as np
import json

f = open('fiatsim.json')
data = json.load(f)

x = [x["result"]["startingDaiBalance"] for x in data]
y = [y["result"]["finalAPY"] for y in data]

plt.plot(x, y)
plt.title('APR per Dai Balance Folded')
plt.xlabel('Starting Dai Balance')
plt.ylabel('APR')
plt.show()

x1 = [x["result"]["totalDaiUsedToPurchasePTs"] for x in data]
y1 = [y["result"]["finalAPY"] for y in data]

plt.plot(x1, y1)
plt.title('APR per total dai leveraged')
plt.xlabel('Total Dai Leveraged')
plt.ylabel('APR')
plt.show()

max_value = max(y)
max_index = y.index(max_value)

max_result = [data[max_index]["result"]]
df = pd.DataFrame(max_result)

df.to_html('result.html')

f.close()
