import React from 'react'
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'

const styles = StyleSheet.create({
  page: {
    padding: 30,
    fontSize: 12,
  },
  header: {
    fontSize: 20,
    marginBottom: 20,
    fontWeight: 'bold',
  },
  section: {
    margin: 10,
    padding: 10,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 5,
  },
})

export const CreditNotePDF = ({ note, user }: { note: any, user: any }) => (
  <Document>
    <Page size="A4" style={styles.page}>
      <Text style={styles.header}>Credit Note {note.number}</Text>
      <View style={styles.section}>
        <View style={styles.row}>
          <Text>Issued To:</Text>
          <Text>{user.name || user.email}</Text>
        </View>
        <View style={styles.row}>
          <Text>Invoice Ref:</Text>
          <Text>{note.invoiceId}</Text>
        </View>
        <View style={styles.row}>
          <Text>Amount:</Text>
          <Text>{note.amount} {note.currency}</Text>
        </View>
        <View style={styles.row}>
          <Text>Reason:</Text>
          <Text>{note.reason}</Text>
        </View>
        <View style={styles.row}>
          <Text>Date:</Text>
          <Text>{new Date(note.issuedAt).toLocaleDateString()}</Text>
        </View>
      </View>
    </Page>
  </Document>
)
